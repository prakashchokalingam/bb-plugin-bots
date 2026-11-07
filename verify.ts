// Pure webhook crypto and URL helpers — no BB handle, no I/O. Everything here
// is unit-testable without a running server.
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  HOOK_PATH_PREFIX,
  HOOK_SECRET_PREFIX,
  HOOK_SIGNATURE_PREFIX,
  HOOK_TIMESTAMP_SKEW_SECONDS,
  LISTENER_PORT_MAX,
  LISTENER_PORT_MIN,
} from "./hook-contract.js";

export const BASE_URL_ERROR = "Use a full URL that starts with https://";

/**
 * The bot's secret, derived on demand from the master key. The database
 * stores only `version`, so rotating is a counter bump and the secret itself
 * never lands on disk.
 */
export function deriveSecret(
  master: Buffer,
  botId: string,
  version: number,
): string {
  const digest = createHmac("sha256", master)
    .update(`bot:${botId}:v${version}`)
    .digest("hex");
  return `${HOOK_SECRET_PREFIX}${digest}`;
}

/**
 * HMAC-SHA256 over `"{timestamp}.{rawBody}"`, keyed with the full secret
 * string (prefix included) — the same thing the README's openssl example
 * computes. Returns bare hex, without the `sha256=` prefix.
 */
export function signPayload(
  secret: string,
  timestamp: string | number,
  rawBody: Buffer | string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex");
}

export type VerifyResult =
  | { ok: true; signature: string }
  | { ok: false; reason: "missing" | "timestamp" | "skew" | "mismatch" };

export function verifySignature(o: {
  secret: string;
  timestamp: string | undefined;
  signatureHeader: string | undefined;
  rawBody: Buffer;
  nowMs: number;
}): VerifyResult {
  const timestamp = o.timestamp?.trim();
  const header = o.signatureHeader?.trim();
  if (!timestamp || !header) return { ok: false, reason: "missing" };
  if (!/^\d{1,15}$/.test(timestamp)) return { ok: false, reason: "timestamp" };
  const skew = Math.abs(o.nowMs / 1000 - Number(timestamp));
  if (skew > HOOK_TIMESTAMP_SKEW_SECONDS) return { ok: false, reason: "skew" };
  if (!header.startsWith(HOOK_SIGNATURE_PREFIX)) {
    return { ok: false, reason: "mismatch" };
  }
  const given = header.slice(HOOK_SIGNATURE_PREFIX.length).toLowerCase();
  const expected = signPayload(o.secret, timestamp, o.rawBody);
  // timingSafeEqual throws on unequal lengths, so the length check comes
  // first. Length is not secret: every valid signature is 64 hex chars.
  if (given.length !== expected.length) return { ok: false, reason: "mismatch" };
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, signature: expected };
}

/**
 * Validates one base URL. Empty means "not set". Only an origin is allowed —
 * a path, query, or fragment would make the hook URL ambiguous — and plain
 * http only for this machine.
 */
export function normalizeBaseUrl(
  input: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: true, value: "" };
  const bad = { ok: false as const, error: BASE_URL_ERROR };
  // URL() silently drops an empty "?" or "#", so check the raw text too.
  if (trimmed.includes("?") || trimmed.includes("#")) return bad;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return bad;
  }
  const isLocalHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalHttp) return bad;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return bad;
  return { ok: true, value: `${url.protocol}//${url.host}` };
}

export interface AllowedBaseUrls {
  /** Valid base URLs, normalised, in the order typed, without repeats. */
  urls: string[];
  /** `host[:port]` of each valid URL: what a request's Host header must equal. */
  hosts: string[];
  /** Entries that are not valid, as typed (trimmed). */
  invalid: string[];
}

/**
 * Reads the `allowedBaseUrls` setting: comma-separated, each entry a full URL.
 * An empty entry is skipped. A bad entry is reported, never fatal.
 */
export function parseAllowedBaseUrls(text: string): AllowedBaseUrls {
  const urls: string[] = [];
  const hosts: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(",")) {
    const entry = part.trim();
    if (entry.length === 0) continue;
    const normalized = normalizeBaseUrl(entry);
    if (!normalized.ok) {
      invalid.push(entry);
      continue;
    }
    if (urls.includes(normalized.value)) continue;
    urls.push(normalized.value);
    hosts.push(new URL(normalized.value).host.toLowerCase());
  }
  return { urls, hosts, invalid };
}

/** The URL a caller posts to, once per base URL: `<base>/hooks/<botId>`. */
export function buildHookUrls(bases: readonly string[], botId: string): string[] {
  return bases.map((base) => `${base.replace(/\/+$/, "")}${HOOK_PATH_PREFIX}${botId}`);
}

/** The `listenerPort` setting as a number, or null when it is not a whole
 * number from 1024 to 65535. */
export function parseListenerPort(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= LISTENER_PORT_MIN && port <= LISTENER_PORT_MAX ? port : null;
}
