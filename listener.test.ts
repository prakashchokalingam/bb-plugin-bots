import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOOK_MAX_BODY_BYTES,
  LISTENER_MAX_CONNECTIONS,
  LISTENER_REASON_PORT_IN_USE,
  LISTENER_REASON_PORT_INVALID,
  LISTENER_REASON_STARTING,
} from "./hook-contract.js";
import type { HookDelivery, HookReply } from "./hook.js";
import { createHookListener } from "./listener.js";

const BOT = "bot_0123456789abcdef";
const OTHER_BOT = "bot_fedcba9876543210";
const HOST = "hooks.example.com";

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const blocker = net.createServer();
    blocker.once("error", reject);
    blocker.listen(port, "127.0.0.1", () => resolve(blocker));
  });
}

const closeServer = (server: net.Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

interface Seen {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  options: {
    method?: string;
    path?: string;
    host?: string | null;
    headers?: Record<string, string>;
    body?: Buffer | string;
    chunks?: Buffer[];
  } = {},
): Promise<Seen> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.host !== null) headers.host = options.host ?? HOST;
    // Node leaves a GET body unframed; frame it, so it is a body and not the
    // start of another request.
    if (options.body !== undefined && options.chunks === undefined) {
      headers["content-length"] = String(Buffer.byteLength(options.body));
    }
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path ?? `/hooks/${BOT}`,
        headers,
        agent: false,
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (chunk: Buffer) => parts.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(parts).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (options.chunks !== undefined) {
      for (const chunk of options.chunks) req.write(chunk);
      req.end();
    } else {
      req.end(options.body);
    }
  });
}

const connectError = (port: number) =>
  request(port, { method: "GET", path: "/" }).then(
    () => "connected",
    (error: NodeJS.ErrnoException) => error.code,
  );

const JSON_HEADERS = { "content-type": "application/json" };

// Everything the listener needs from the rest of the plugin, in memory.
function setup(initial?: { allowedBaseUrls?: string; port?: number; live?: string[] }) {
  const state = {
    allowedBaseUrls: initial?.allowedBaseUrls ?? `https://${HOST}`,
    listenerPort: String(initial?.port ?? 0),
    live: new Set<string>(initial?.live ?? []),
    known: new Set<string>([BOT, OTHER_BOT]),
  };
  const deliveries: HookDelivery[] = [];
  const logs: string[] = [];
  let reply: (delivery: HookDelivery) => Promise<HookReply> = async () => ({
    status: 202,
    body: { threadId: "thr_1" },
  });
  const listener = createHookListener({
    bb: {
      log: {
        debug: () => undefined,
        info: (message: string) => void logs.push(message),
        warn: (message: string) => void logs.push(message),
        error: (message: string) => void logs.push(message),
      },
    },
    readSettings: async () => ({
      allowedBaseUrls: state.allowedBaseUrls,
      listenerPort: state.listenerPort,
    }),
    liveBotCount: () => state.live.size,
    isLive: (botId) => state.live.has(botId),
    processDelivery: async (delivery) => {
      deliveries.push(delivery);
      return reply(delivery);
    },
    bindRetryDelayMs: 10,
    bindRetryMax: 5,
  });
  return {
    state,
    listener,
    deliveries,
    logs,
    setReply: (next: typeof reply) => {
      reply = next;
    },
  };
}

let open: Array<{ listener: { dispose: () => Promise<void> } }> = [];
const blockers: net.Server[] = [];

// A started listener on a fresh port, with one live bot.
async function started(initial?: { allowedBaseUrls?: string; live?: string[] }) {
  const port = await freePort();
  const ctx = setup({ port, live: [BOT], ...initial });
  open.push(ctx);
  await ctx.listener.reconcile();
  expect(ctx.listener.status()).toEqual({ state: "running", port, reason: null });
  return { ...ctx, port };
}

afterEach(async () => {
  for (const ctx of open) await ctx.listener.dispose();
  open = [];
  for (const blocker of blockers.splice(0)) {
    if (blocker.listening) await closeServer(blocker);
  }
});

describe("lifecycle", () => {
  it("stays closed while no bot has its hook on", async () => {
    const port = await freePort();
    const ctx = setup({ port });
    open.push(ctx);
    await ctx.listener.reconcile();
    expect(ctx.listener.status()).toEqual({ state: "stopped", port, reason: null });
    expect(await connectError(port)).toBe("ECONNREFUSED");
  });

  it("stays closed while no base URL is valid, and ignores a bad entry", async () => {
    const port = await freePort();
    const ctx = setup({ port, live: [BOT], allowedBaseUrls: "hooks.example.com, http://hooks.example.com" });
    open.push(ctx);
    await ctx.listener.reconcile();
    expect(ctx.listener.status().state).toBe("stopped");
    expect(await connectError(port)).toBe("ECONNREFUSED");
  });

  it("opens on 127.0.0.1 once a bot is live and a base URL is valid", async () => {
    const { port } = await started();
    expect((await request(port, { method: "GET", path: "/" })).status).toBe(404);
  });

  it("binds loopback only", async () => {
    const { port } = await started();
    // A server bound to 0.0.0.0 also answers on this machine's own LAN address.
    // Bound to 127.0.0.1 it refuses there. (127.0.0.2 is not usable: macOS has
    // no such address, so a connect to it just hangs.)
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal);
    if (lan === undefined) return; // no network interface: nothing to probe
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: lan.address, port });
      const done = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(1500, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
    expect(reachable).toBe(false);
    // And the loopback address does answer.
    expect((await request(port, { method: "GET", path: "/" })).status).toBe(404);
  });

  it("closes when the last live bot goes away", async () => {
    const ctx = await started();
    ctx.state.live.clear();
    await ctx.listener.reconcile();
    expect(ctx.listener.status()).toEqual({ state: "stopped", port: ctx.port, reason: null });
    expect(await connectError(ctx.port)).toBe("ECONNREFUSED");

    ctx.state.live.add(BOT);
    await ctx.listener.reconcile();
    expect(ctx.listener.status().state).toBe("running");
    expect((await request(ctx.port, { method: "GET", path: "/" })).status).toBe(404);
  });

  it("closes when every base URL is removed", async () => {
    const ctx = await started();
    ctx.state.allowedBaseUrls = "";
    await ctx.listener.reconcile();
    expect(ctx.listener.status().state).toBe("stopped");
    expect(await connectError(ctx.port)).toBe("ECONNREFUSED");
  });

  it("follows the allowed hosts without restarting", async () => {
    const ctx = await started();
    ctx.state.allowedBaseUrls = "https://other.example.com";
    await ctx.listener.reconcile();
    expect(ctx.listener.status().state).toBe("running");
    expect((await request(ctx.port, { host: HOST })).status).toBe(421);
    expect((await request(ctx.port, { host: "other.example.com", headers: JSON_HEADERS })).status).toBe(202);
  });

  it("moves to the new port when the port setting changes", async () => {
    const ctx = await started();
    const next = await freePort();
    ctx.state.listenerPort = String(next);
    await ctx.listener.reconcile();
    expect(ctx.listener.status()).toEqual({ state: "running", port: next, reason: null });
    expect(await connectError(ctx.port)).toBe("ECONNREFUSED");
    expect((await request(next, { method: "GET", path: "/" })).status).toBe(404);
  });

  it("opens one listener however often it is reconciled, even at the same time", async () => {
    const port = await freePort();
    const ctx = setup({ port, live: [BOT] });
    open.push(ctx);
    await Promise.all([ctx.listener.reconcile(), ctx.listener.reconcile(), ctx.listener.reconcile()]);
    await ctx.listener.reconcile();
    expect(ctx.listener.status().state).toBe("running");
    expect(ctx.logs.filter((line) => line.startsWith("webhook listener open"))).toHaveLength(1);
  });

  it("dispose closes the port and drops open keep-alive connections", async () => {
    const ctx = await started();
    const socket = net.connect({ host: "127.0.0.1", port: ctx.port });
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    // Leave the connection idle, as a keep-alive client would.
    socket.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`);
    await new Promise<void>((resolve) => socket.once("data", () => resolve()));

    await ctx.listener.dispose();
    await closed;
    expect(await connectError(ctx.port)).toBe("ECONNREFUSED");
    expect(ctx.listener.status().state).toBe("stopped");

    // A reconcile after dispose does not open it again.
    await ctx.listener.reconcile();
    expect(await connectError(ctx.port)).toBe("ECONNREFUSED");
  });

  it("reports the port as in use, keeps working, and recovers on the next reconcile", async () => {
    const port = await freePort();
    const blocker = await occupy(port);
    blockers.push(blocker);
    const ctx = setup({ port, live: [BOT] });
    open.push(ctx);

    await ctx.listener.reconcile();
    await vi.waitFor(() =>
      expect(ctx.listener.status()).toEqual({
        state: "error",
        port,
        reason: LISTENER_REASON_PORT_IN_USE,
      }),
    );

    await closeServer(blocker);
    await ctx.listener.reconcile();
    expect(ctx.listener.status()).toEqual({ state: "running", port, reason: null });
  });

  it("retries the bind in the background and does not wait for it", async () => {
    // A reload loads the new instance while the old one still holds the port.
    const port = await freePort();
    const blocker = await occupy(port);
    blockers.push(blocker);
    const ctx = setup({ port, live: [BOT] });
    open.push(ctx);

    await ctx.listener.reconcile();
    expect(ctx.listener.status()).toEqual({
      state: "stopped",
      port,
      reason: LISTENER_REASON_STARTING,
    });

    await closeServer(blocker);
    await vi.waitFor(() =>
      expect(ctx.listener.status()).toEqual({ state: "running", port, reason: null }),
    );
    expect((await request(port, { method: "GET", path: "/" })).status).toBe(404);
  });

  it("a stop during the retries cancels them", async () => {
    const port = await freePort();
    const blocker = await occupy(port);
    blockers.push(blocker);
    const ctx = setup({ port, live: [BOT] });
    open.push(ctx);
    await ctx.listener.reconcile();
    ctx.state.live.clear();
    await ctx.listener.reconcile();
    await closeServer(blocker);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await connectError(port)).toBe("ECONNREFUSED");
    expect(ctx.listener.status().state).toBe("stopped");
  });

  it("shows an error for a port that is not 1024–65535, without listening", async () => {
    const ctx = setup({ live: [BOT] });
    open.push(ctx);
    for (const bad of ["80", "abc", ""]) {
      ctx.state.listenerPort = bad;
      await ctx.listener.reconcile();
      expect(ctx.listener.status()).toMatchObject({
        state: "error",
        reason: LISTENER_REASON_PORT_INVALID,
      });
    }
  });
});

describe("request chain", () => {
  it("421 with an empty body when Host is not an allowed host", async () => {
    const { port, deliveries } = await started();
    for (const host of ["evil.example.com", `${HOST}:8443`, `127.0.0.1:${port}`, "", "hooks.example.com.evil.com"]) {
      const seen = await request(port, { host, headers: JSON_HEADERS, body: "{}" });
      expect(seen.status).toBe(421);
      expect(seen.body).toBe("");
    }
    // No Host header at all (HTTP/1.0 style) is not allowed either.
    const none = await request(port, { host: null, headers: JSON_HEADERS, body: "{}" });
    expect(none.status === 421 || none.status === 400).toBe(true);
    expect(deliveries).toHaveLength(0);
  });

  it("the Host check runs before the path check", async () => {
    const { port } = await started();
    expect((await request(port, { host: "evil.example.com", method: "GET", path: "/" })).status).toBe(421);
  });

  it("matches the Host header without regard to case, and a listed port", async () => {
    const { port } = await started({ allowedBaseUrls: `https://${HOST}, http://127.0.0.1:38990` });
    expect((await request(port, { host: "HOOKS.Example.COM", headers: JSON_HEADERS, body: "{}" })).status).toBe(202);
    expect((await request(port, { host: "127.0.0.1:38990", headers: JSON_HEADERS, body: "{}" })).status).toBe(202);
  });

  it.each([
    ["GET /", "GET", "/"],
    ["POST /", "POST", "/"],
    ["GET /api/v1/threads", "GET", "/api/v1/threads"],
    ["POST /api/v1/threads", "POST", "/api/v1/threads"],
    ["GET the hook path", "GET", `/hooks/${BOT}`],
    ["PUT the hook path", "PUT", `/hooks/${BOT}`],
    ["path traversal out of the hook", "POST", `/hooks/${BOT}/../../api/v1/threads`],
    ["path traversal into a hook", "POST", `/hooks/x/../${BOT}/../..`],
    ["dot segments", "POST", "/hooks/x/../.."],
    ["encoded dot segments", "POST", `/hooks/${BOT}/%2e%2e/%2e%2e`],
    ["encoded slash", "POST", `/hooks%2f${BOT}`],
    ["encoded bot id", "POST", `/hooks/bot%5F0123456789abcdef`],
    ["a protocol-relative target", "POST", `//evil.example.com/hooks/${BOT}`],
    ["an absolute-form target", "POST", `http://${HOST}/hooks/${BOT}`],
    ["a backslash for the slash", "POST", `/hooks\\${BOT}`],
    ["trailing slash", "POST", `/hooks/${BOT}/`],
    ["extra segment", "POST", `/hooks/${BOT}/extra`],
    ["no bot id", "POST", "/hooks/"],
    ["the prefix alone", "POST", "/hooks"],
    ["a short bot id", "POST", "/hooks/bot_0123"],
    ["an upper-case bot id", "POST", `/hooks/${BOT.toUpperCase()}`],
    ["the old BB route", "POST", `/api/v1/plugins/bots/http/hook?id=${BOT}`],
    ["the old path", "POST", `/hook?id=${BOT}`],
  ])("404 for %s, and BB's API is never reached", async (_name, method, path) => {
    const { port, deliveries } = await started();
    const seen = await request(port, { method, path, headers: JSON_HEADERS, body: "{}" });
    expect(seen.status).toBe(404);
    expect(seen.body).toBe('{"error":"not found"}');
    expect(deliveries).toHaveLength(0);
  });

  it("answers the same 404 for a wrong path and for an unknown, draft or disabled bot", async () => {
    const { port, deliveries } = await started();
    // OTHER_BOT stands for a draft or a disabled bot: known, but not live.
    const cases = [
      { path: "/" },
      { path: `/hooks/${OTHER_BOT}` },
      { path: "/hooks/bot_aaaaaaaaaaaaaaaa" },
      { method: "GET", path: `/hooks/${BOT}` },
    ];
    const answers: Array<Omit<Seen, "headers"> & { headers: Record<string, unknown> }> = [];
    for (const one of cases) {
      const seen = await request(port, { headers: JSON_HEADERS, body: "{}", ...one });
      const { date: _date, ...headers } = seen.headers;
      answers.push({ status: seen.status, headers, body: seen.body });
    }
    expect(answers[0]!.status).toBe(404);
    for (const other of answers.slice(1)) expect(other).toEqual(answers[0]);
    expect(deliveries).toHaveLength(0);
  });

  it("looks the bot up before it reads the body", async () => {
    const { port, deliveries } = await started();
    // A body that would be too large, for a bot that is not live: 404, not 413.
    const seen = await request(port, {
      path: `/hooks/${OTHER_BOT}`,
      headers: JSON_HEADERS,
      body: Buffer.alloc(HOOK_MAX_BODY_BYTES + 1, 120),
    });
    expect(seen.status).toBe(404);
    expect(deliveries).toHaveLength(0);
  });

  it("413 for a Content-Length over 256 KB, before the body is read", async () => {
    const { port, deliveries } = await started();
    const seen = await request(port, {
      headers: JSON_HEADERS,
      body: Buffer.alloc(300 * 1024, 120),
    });
    expect(seen.status).toBe(413);
    expect(deliveries).toHaveLength(0);
  });

  it("413 for a chunked body that goes past 256 KB", async () => {
    const { port, deliveries } = await started();
    const chunk = Buffer.alloc(64 * 1024, 120);
    const seen = await request(port, {
      headers: { ...JSON_HEADERS, "transfer-encoding": "chunked" },
      chunks: [chunk, chunk, chunk, chunk, chunk],
    });
    expect(seen.status).toBe(413);
    expect(deliveries).toHaveLength(0);
  });

  it("accepts a body of exactly 256 KB", async () => {
    const { port, deliveries } = await started();
    const body = Buffer.alloc(HOOK_MAX_BODY_BYTES, 120);
    const seen = await request(port, { headers: { "content-type": "text/plain" }, body });
    expect(seen.status).toBe(202);
    expect(deliveries[0]!.rawBody.length).toBe(HOOK_MAX_BODY_BYTES);
  });

  it("415 for any type other than application/json or text/plain", async () => {
    const { port, deliveries } = await started();
    for (const type of ["text/xml", "application/x-www-form-urlencoded", "multipart/form-data", ""]) {
      const seen = await request(port, {
        headers: type === "" ? {} : { "content-type": type },
        body: "<a/>",
      });
      expect(seen.status).toBe(415);
    }
    expect(deliveries).toHaveLength(0);
  });

  it("hands a valid request to processDelivery with the headers and the raw body", async () => {
    const { port, deliveries } = await started();
    const body = '{"text":"Checkout fails on Safari 17"}';
    const seen = await request(port, {
      host: "Hooks.Example.com",
      headers: {
        "content-type": "Application/JSON; charset=utf-8",
        "x-hook-timestamp": "1793700000",
        "x-hook-signature": "sha256=abc",
        "idempotency-key": "key-1",
      },
      body,
    });
    expect(seen.status).toBe(202);
    expect(JSON.parse(seen.body)).toEqual({ threadId: "thr_1" });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      botId: BOT,
      host: HOST,
      contentType: "application/json",
      timestamp: "1793700000",
      signature: "sha256=abc",
      idemKey: "key-1",
    });
    expect(deliveries[0]!.rawBody.toString()).toBe(body);
    expect(Math.abs(deliveries[0]!.receivedAt - Date.now())).toBeLessThan(5000);
  });

  it("ignores a query string on the hook path", async () => {
    const { port, deliveries } = await started();
    const seen = await request(port, { path: `/hooks/${BOT}?x=1`, headers: JSON_HEADERS, body: "{}" });
    expect(seen.status).toBe(202);
    expect(deliveries[0]!.botId).toBe(BOT);
  });

  it("passes the status, body and headers of the reply through", async () => {
    const ctx = await started();
    ctx.setReply(async () => ({
      status: 429,
      body: { error: "rate limited" },
      headers: { "retry-after": "7" },
    }));
    const seen = await request(ctx.port, { headers: JSON_HEADERS, body: "{}" });
    expect(seen.status).toBe(429);
    expect(seen.headers["retry-after"]).toBe("7");
    expect(JSON.parse(seen.body)).toEqual({ error: "rate limited" });
  });

  it("answers 500 when the handler throws, logs it, and keeps serving", async () => {
    const ctx = await started();
    ctx.setReply(async () => {
      throw new Error("database is closed");
    });
    const failed = await request(ctx.port, { headers: JSON_HEADERS, body: "{}" });
    expect(failed.status).toBe(500);
    expect(failed.body).toBe('{"error":"internal error"}');
    expect(ctx.logs.some((line) => line.includes("database is closed"))).toBe(true);

    ctx.setReply(async () => ({ status: 202, body: { threadId: "thr_2" } }));
    const next = await request(ctx.port, { headers: JSON_HEADERS, body: "{}" });
    expect(next.status).toBe(202);
  });

  it("answers 500 when the bot lookup throws", async () => {
    const port = await freePort();
    const listener = createHookListener({
      bb: { log: { debug() {}, info() {}, warn() {}, error() {} } },
      readSettings: async () => ({ allowedBaseUrls: `https://${HOST}`, listenerPort: String(port) }),
      liveBotCount: () => 1,
      isLive: () => {
        throw new Error("lookup failed");
      },
      processDelivery: async () => ({ status: 202 }),
    });
    open.push({ listener });
    await listener.reconcile();
    expect((await request(port, { headers: JSON_HEADERS, body: "{}" })).status).toBe(500);
    expect((await request(port, { host: "evil.example.com" })).status).toBe(421);
  });

  it("answers 400 to a request that is not valid HTTP and keeps serving", async () => {
    const { port } = await started();
    const answer = await new Promise<string>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      let received = "";
      socket.on("data", (chunk) => (received += chunk.toString()));
      socket.on("close", () => resolve(received));
      socket.on("connect", () => socket.write("NOT HTTP AT ALL\r\n\r\n"));
    });
    expect(answer.startsWith("HTTP/1.1 400")).toBe(true);
    expect((await request(port, { method: "GET", path: "/" })).status).toBe(404);
  });

  it("refuses connections past the limit of 64", async () => {
    const { port } = await started();
    const sockets: net.Socket[] = [];
    try {
      for (let n = 0; n < LISTENER_MAX_CONNECTIONS; n += 1) {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.on("error", () => undefined);
        await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
        sockets.push(socket);
      }
      // The 65th is closed by the server without an answer.
      const extra = net.connect({ host: "127.0.0.1", port });
      extra.on("error", () => undefined);
      const closed = await new Promise<boolean>((resolve) => {
        extra.once("close", () => resolve(true));
        setTimeout(() => resolve(false), 2000);
      });
      expect(closed).toBe(true);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });
});
