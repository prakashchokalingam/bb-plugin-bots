// Webhook listener — a node:http server bound to 127.0.0.1 that the plugin
// opens itself, only while a published bot has its webhook on and at least one
// base URL is valid. BB's own HTTP server never sees this traffic.
//
// This file runs steps 0–4 of the request chain, the ones that need no secret:
//   0 connection limits   1 Host   2 method + path   3 bot   4 size + type
// then hands the request to hook.ts (processDelivery) for the rest.
import * as http from "node:http";
import type { Socket } from "node:net";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  DEFAULT_LISTENER_PORT,
  HOOK_MAX_BODY_BYTES,
  HOOK_PATH_PREFIX,
  HOOK_HEADER_IDEMPOTENCY,
  HOOK_HEADER_SIGNATURE,
  HOOK_HEADER_TIMESTAMP,
  LISTENER_HEADERS_TIMEOUT_MS,
  LISTENER_KEEP_ALIVE_TIMEOUT_MS,
  LISTENER_MAX_CONNECTIONS,
  LISTENER_REASON_PORT_IN_USE,
  LISTENER_REASON_PORT_INVALID,
  LISTENER_REASON_STARTING,
  LISTENER_REQUEST_TIMEOUT_MS,
  type HookState,
} from "./hook-contract.js";
import { NOT_FOUND_REPLY, type HookDelivery, type HookReply } from "./hook.js";
import { parseAllowedBaseUrls, parseListenerPort } from "./verify.js";

export type ListenerStatus = HookState["listener"];

/** The two plugin settings the listener follows. */
export interface ListenerSettings {
  allowedBaseUrls: string;
  listenerPort: string;
}

/** Loopback only: the tunnel runs on this machine and connects here. */
const BIND_ADDRESS = "127.0.0.1";

// A reload loads the new plugin instance before it disposes the old one, so
// for a moment the old instance still holds the port. Retry the bind instead
// of failing, and never make plugin load wait for it.
const DEFAULT_BIND_RETRY_DELAY_MS = 500;
const DEFAULT_BIND_RETRY_MAX = 10;

// bot_ids are "bot_" + 16 hex chars (newBotId).
const PATH_PATTERN = new RegExp(`^${HOOK_PATH_PREFIX}(bot_[0-9a-f]{16})$`);

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

/** The bot id when `rawUrl` is exactly /hooks/<botId> after URL
 * normalisation (so "/hooks/bot_x/../.." and "%2e%2e" are not a match). */
function matchBotId(rawUrl: string | undefined): string | null {
  // Origin-form only. URL() would also read "//host/hooks/…" as a host and
  // "/hooks\\…" as a slash, and make both look like the hook path.
  if (rawUrl === undefined || !rawUrl.startsWith("/") || rawUrl.startsWith("//")) return null;
  if (rawUrl.includes("\\")) return null;
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://listener.invalid").pathname;
  } catch {
    return null;
  }
  return PATH_PATTERN.exec(pathname)?.[1] ?? null;
}

// Sockets that already got an answer. Bytes left over after that answer (a body
// on a request that was refused early) parse as a bad next request; they must
// not earn a second response on the same socket.
const answered = new WeakSet<object>();

// A refused request may still be uploading. If the reply goes out and the
// socket closes on unread data, TCP resets the connection and the caller loses
// the answer; a client that sent "Connection: close" gets exactly that, because
// Node closes right after the reply. So a refusal is sent only once the body
// has been read and thrown away. Past this many bytes the connection is cut.
const DRAIN_LIMIT_BYTES = 1024 * 1024;

function send(res: http.ServerResponse, reply: HookReply): void {
  if (res.socket !== null) answered.add(res.socket);
  const payload = reply.body === undefined ? "" : JSON.stringify(reply.body);
  res.writeHead(reply.status, {
    ...(payload.length > 0 ? { "content-type": "application/json" } : {}),
    "content-length": String(Buffer.byteLength(payload)),
    ...reply.headers,
  });
  res.end(payload);
}

/** Reads and discards the body, then answers. Never buffers it. */
function refuse(req: http.IncomingMessage, res: http.ServerResponse, reply: HookReply): void {
  if (req.complete) return send(res, reply);
  let total = 0;
  req.on("data", (chunk: Buffer) => {
    total += chunk.length;
    if (total > DRAIN_LIMIT_BYTES) req.destroy();
  });
  req.on("end", () => send(res, reply));
  req.on("error", () => undefined);
}

/**
 * Reads at most `limit` bytes. Resolves null, at the end of the body, if it
 * went past that. What is past the limit is thrown away as it arrives, so
 * memory stays bounded and the 413 can still reach the caller.
 */
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (over) {
        if (total > DRAIN_LIMIT_BYTES) req.destroy();
        return;
      }
      if (total > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("close", () => {
      if (!req.complete) reject(new Error("request closed before the body ended"));
    });
  });
}

interface Open {
  server: http.Server;
  port: number;
  sockets: Set<Socket>;
  listening: boolean;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createHookListener(deps: {
  bb: Pick<BbPluginApi, "log">;
  readSettings: () => Promise<ListenerSettings>;
  /** Published bots with the hook on. */
  liveBotCount: () => number;
  /** Published and hook on, for one bot. */
  isLive: (botId: string) => boolean;
  processDelivery: (delivery: HookDelivery) => Promise<HookReply>;
  bindRetryDelayMs?: number;
  bindRetryMax?: number;
}) {
  const { bb, readSettings, liveBotCount, isLive, processDelivery } = deps;
  const retryDelayMs = deps.bindRetryDelayMs ?? DEFAULT_BIND_RETRY_DELAY_MS;
  const retryMax = deps.bindRetryMax ?? DEFAULT_BIND_RETRY_MAX;

  let current: Open | null = null;
  let hosts = new Set<string>();
  let disposed = false;
  let status: ListenerStatus = {
    state: "stopped",
    port: Number(DEFAULT_LISTENER_PORT),
    reason: null,
  };
  let queue: Promise<void> = Promise.resolve();

  // ── Request chain ──────────────────────────────────────────────────────────

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const receivedAt = Date.now();

    // 1. Host: exact match against the allowed list. Not authentication; it
    // keeps scanners and browser pages out. Empty body, no detail.
    const host = (req.headers.host ?? "").toLowerCase();
    if (!hosts.has(host)) return refuse(req, res, { status: 421 });

    // 2. Method and path.
    const botId = req.method === "POST" ? matchBotId(req.url) : null;
    if (botId === null) return refuse(req, res, NOT_FOUND_REPLY);

    // 3. Bot: exists, published, hook on. The same 404 as a wrong path.
    if (!isLive(botId)) return refuse(req, res, NOT_FOUND_REPLY);

    // 4. Size and type, before the body is read.
    const declared = Number(headerValue(req.headers["content-length"]));
    if (Number.isFinite(declared) && declared > HOOK_MAX_BODY_BYTES) {
      return refuse(req, res, { status: 413, body: { error: "body too large" } });
    }
    const mediaType = (headerValue(req.headers["content-type"]) ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (mediaType !== "application/json" && mediaType !== "text/plain") {
      return refuse(req, res, {
        status: 415,
        body: { error: "use application/json or text/plain" },
      });
    }
    const rawBody = await readBody(req, HOOK_MAX_BODY_BYTES);
    if (rawBody === null) {
      return send(res, { status: 413, body: { error: "body too large" } });
    }

    // 5–7. Signature, rate, claim, spawn.
    const reply = await processDelivery({
      botId,
      host,
      contentType: mediaType,
      timestamp: headerValue(req.headers[HOOK_HEADER_TIMESTAMP]),
      signature: headerValue(req.headers[HOOK_HEADER_SIGNATURE]),
      idemKey: headerValue(req.headers[HOOK_HEADER_IDEMPOTENCY]),
      rawBody,
      receivedAt,
    });
    send(res, reply);
  }

  // Nothing may throw out of a request handler: an uncaught error there is
  // reported against the whole plugin. Every failure becomes a 500.
  function onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.on("error", () => undefined);
    handle(req, res).catch((error: unknown) => {
      bb.log.warn(
        `webhook listener: request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        if (res.headersSent || res.destroyed) {
          res.destroy();
        } else {
          send(res, { status: 500, body: { error: "internal error" } });
        }
      } catch {
        res.destroy();
      }
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  function setStatus(next: ListenerStatus): void {
    status = next;
  }

  function create(port: number): Open {
    const server = http.createServer(onRequest);
    // 0. Connection limits.
    server.maxConnections = LISTENER_MAX_CONNECTIONS;
    server.headersTimeout = LISTENER_HEADERS_TIMEOUT_MS;
    server.requestTimeout = LISTENER_REQUEST_TIMEOUT_MS;
    server.keepAliveTimeout = LISTENER_KEEP_ALIVE_TIMEOUT_MS;
    const open: Open = {
      server,
      port,
      sockets: new Set(),
      listening: false,
      attempts: 0,
      timer: null,
    };
    server.on("connection", (socket) => {
      open.sockets.add(socket);
      socket.on("close", () => open.sockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => {
      if (answered.has(socket)) {
        socket.end();
      } else if (socket.writable && !socket.destroyed) {
        socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      } else {
        socket.destroy();
      }
    });
    server.on("error", (error) => {
      if (open.listening) bb.log.warn(`webhook listener error: ${String(error)}`);
    });
    return open;
  }

  // One bind attempt. Resolves when the attempt has an outcome: listening, a
  // retry scheduled, or a final error. The retries run in the background.
  function attempt(open: Open): Promise<void> {
    return new Promise((resolve) => {
      open.attempts += 1;
      const onListening = () => {
        open.server.off("error", onError);
        if (current !== open) {
          // Stopped while the bind was in flight.
          open.server.close();
        } else {
          open.listening = true;
          setStatus({ state: "running", port: open.port, reason: null });
          bb.log.info(`webhook listener open on ${BIND_ADDRESS}:${open.port}`);
        }
        resolve();
      };
      const onError = (error: NodeJS.ErrnoException) => {
        open.server.off("listening", onListening);
        if (current === open) {
          if (error.code === "EADDRINUSE" && open.attempts < retryMax) {
            setStatus({ state: "stopped", port: open.port, reason: LISTENER_REASON_STARTING });
            open.timer = setTimeout(() => {
              open.timer = null;
              if (current === open) void attempt(open);
            }, retryDelayMs);
          } else {
            current = null;
            const reason =
              error.code === "EADDRINUSE" ? LISTENER_REASON_PORT_IN_USE : error.message;
            setStatus({ state: "error", port: open.port, reason });
            bb.log.warn(`webhook listener could not open ${BIND_ADDRESS}:${open.port}: ${error.message}`);
          }
        }
        resolve();
      };
      open.server.once("listening", onListening);
      open.server.once("error", onError);
      open.server.listen(open.port, BIND_ADDRESS);
    });
  }

  async function start(port: number): Promise<void> {
    const open = create(port);
    current = open;
    setStatus({ state: "stopped", port, reason: LISTENER_REASON_STARTING });
    await attempt(open);
  }

  // Closes the port and drops every open connection, so nothing keeps the
  // old server alive after a stop, a reload, or a port change.
  async function stop(): Promise<void> {
    const open = current;
    if (open === null) return;
    current = null;
    if (open.timer !== null) clearTimeout(open.timer);
    const closed = open.listening
      ? new Promise<void>((resolve) => open.server.close(() => resolve()))
      : Promise.resolve();
    for (const socket of open.sockets) socket.destroy();
    await closed;
    if (open.listening) bb.log.info(`webhook listener closed on ${BIND_ADDRESS}:${open.port}`);
  }

  async function run(): Promise<void> {
    if (disposed) return;
    const settings = await readSettings();
    const base = parseAllowedBaseUrls(settings.allowedBaseUrls);
    const port = parseListenerPort(settings.listenerPort);
    hosts = new Set(base.hosts);
    const shownPort = port ?? Number(DEFAULT_LISTENER_PORT);

    // Open only while a published bot has its hook on AND a base URL is valid.
    const want = liveBotCount() >= 1 && base.urls.length >= 1;
    if (!want) {
      await stop();
      setStatus({ state: "stopped", port: shownPort, reason: null });
      return;
    }
    if (port === null) {
      await stop();
      setStatus({ state: "error", port: shownPort, reason: LISTENER_REASON_PORT_INVALID });
      return;
    }
    // Already open on this port, or still retrying the bind on it.
    if (current !== null && current.port === port) return;
    await stop();
    await start(port);
  }

  /**
   * Brings the listener in line with the bots and the settings. Safe to call
   * from anywhere, any number of times; calls run one after another. Resolves
   * after the first bind attempt, never after the retries.
   */
  function reconcile(): Promise<void> {
    const next = queue.then(run).catch((error: unknown) => {
      bb.log.warn(
        `webhook listener: reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    queue = next;
    return next;
  }

  /** Plugin unload, reload, or disable. Closes the port for good. */
  async function dispose(): Promise<void> {
    disposed = true;
    await queue;
    await stop();
    setStatus({ ...status, state: "stopped", reason: null });
  }

  return { reconcile, dispose, status: () => status };
}
