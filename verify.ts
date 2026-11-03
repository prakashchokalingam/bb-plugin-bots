// Pure webhook crypto and URL helpers — no BB handle, no I/O. Everything here
// is unit-testable without a running server.
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  HOOK_ROUTE_PATH,
  HOOK_SECRET_PREFIX,
  HOOK_SIGNATURE_PREFIX,
  HOOK_TIMESTAMP_SKEW_SECONDS,
} from "./hook-contract.js";

/**
 * The mount point of a plugin's HTTP routes. BB mounts them under the id the
 * plugin is installed with, so callers pass `bb.pluginId`, never a fixed id.
 */
export function httpBasePath(pluginId: string): string {
  return `/api/v1/plugins/${encodeURIComponent(pluginId)}/http`;
}

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
 * Validates the `publicBaseUrl` setting. Empty means "not set". Only an
 * origin is allowed — a path, query, or fragment would make the hook URL
 * ambiguous — and plain http only for this machine.
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

/**
 * `url` is what a caller posts to: the public base when one is set, else
 * loopback. `localUrl` is always loopback, for scripts on this machine.
 */
export function buildHookUrl(
  publicBase: string | null,
  loopbackBase: string,
  pluginId: string,
  botId: string,
): { url: string; localUrl: string; isPublic: boolean } {
  const suffix = `${httpBasePath(pluginId)}${HOOK_ROUTE_PATH}?id=${encodeURIComponent(botId)}`;
  const localUrl = `${loopbackBase.replace(/\/+$/, "")}${suffix}`;
  const isPublic = publicBase !== null && publicBase.length > 0;
  return {
    url: isPublic ? `${publicBase.replace(/\/+$/, "")}${suffix}` : localUrl,
    localUrl,
    isPublic,
  };
}
