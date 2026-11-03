import { describe, expect, it } from "vitest";
import {
  BASE_URL_ERROR,
  buildHookUrl,
  deriveSecret,
  normalizeBaseUrl,
  signPayload,
  verifySignature,
} from "./verify.js";

const SECRET = "whsec_test";
const TS = "1793700000";
const BODY = '{"text":"Checkout fails on Safari 17"}';
const SIG = "e8ac5b56a1832dc85a3b58da4ea27c6e4667e233f56d28285b5102d7ff0136a6";
const NOW_MS = Number(TS) * 1000;

function verify(overrides: Partial<Parameters<typeof verifySignature>[0]> = {}) {
  return verifySignature({
    secret: SECRET,
    timestamp: TS,
    signatureHeader: `sha256=${SIG}`,
    rawBody: Buffer.from(BODY),
    nowMs: NOW_MS,
    ...overrides,
  });
}

describe("signPayload", () => {
  it("matches the spec's known vector for both string and Buffer bodies", () => {
    expect(signPayload(SECRET, TS, BODY)).toBe(SIG);
    expect(signPayload(SECRET, Number(TS), Buffer.from(BODY))).toBe(SIG);
  });
});

describe("deriveSecret", () => {
  const master = Buffer.alloc(32, 7);

  it("is stable for the same bot and version", () => {
    const secret = deriveSecret(master, "bot_a", 1);
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(deriveSecret(master, "bot_a", 1)).toBe(secret);
  });

  it("changes with the version, the bot, and the master key", () => {
    const secret = deriveSecret(master, "bot_a", 1);
    expect(deriveSecret(master, "bot_a", 2)).not.toBe(secret);
    expect(deriveSecret(master, "bot_b", 1)).not.toBe(secret);
    expect(deriveSecret(Buffer.alloc(32, 8), "bot_a", 1)).not.toBe(secret);
  });
});

describe("verifySignature", () => {
  it("accepts the known vector and returns the bare hex signature", () => {
    expect(verify()).toEqual({ ok: true, signature: SIG });
  });

  it("accepts an upper-case hex signature", () => {
    expect(verify({ signatureHeader: `sha256=${SIG.toUpperCase()}` })).toEqual({
      ok: true,
      signature: SIG,
    });
  });

  it("rejects a missing timestamp or signature header", () => {
    expect(verify({ timestamp: undefined })).toEqual({ ok: false, reason: "missing" });
    expect(verify({ signatureHeader: undefined })).toEqual({ ok: false, reason: "missing" });
    expect(verify({ signatureHeader: "" })).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects a timestamp that is not unix seconds", () => {
    expect(verify({ timestamp: "yesterday" })).toEqual({ ok: false, reason: "timestamp" });
    expect(verify({ timestamp: "1793700000.5" })).toEqual({ ok: false, reason: "timestamp" });
  });

  it("allows 300 s of skew either way and rejects more", () => {
    expect(verify({ nowMs: NOW_MS + 300_000 }).ok).toBe(true);
    expect(verify({ nowMs: NOW_MS - 300_000 }).ok).toBe(true);
    expect(verify({ nowMs: NOW_MS + 301_000 })).toEqual({ ok: false, reason: "skew" });
    expect(verify({ nowMs: NOW_MS - 301_000 })).toEqual({ ok: false, reason: "skew" });
    expect(verify({ nowMs: NOW_MS + 10 * 60_000 })).toEqual({ ok: false, reason: "skew" });
  });

  it("rejects a body changed by one byte", () => {
    const tampered = Buffer.from(BODY);
    tampered[tampered.length - 2] ^= 1;
    expect(verify({ rawBody: tampered })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a header without the sha256= prefix", () => {
    expect(verify({ signatureHeader: SIG })).toEqual({ ok: false, reason: "mismatch" });
    expect(verify({ signatureHeader: `sha1=${SIG}` })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a signature of the wrong length without throwing", () => {
    expect(verify({ signatureHeader: `sha256=${SIG.slice(2)}` })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects the right signature under a different secret", () => {
    expect(verify({ secret: "whsec_other" })).toEqual({ ok: false, reason: "mismatch" });
  });
});

describe("normalizeBaseUrl", () => {
  it.each([
    ["", ""],
    ["   ", ""],
    ["https://hooks.example.com", "https://hooks.example.com"],
    ["  https://hooks.example.com/  ", "https://hooks.example.com"],
    ["https://hooks.example.com:8443", "https://hooks.example.com:8443"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:38886/", "http://127.0.0.1:38886"],
  ])("accepts %j as %j", (input, value) => {
    expect(normalizeBaseUrl(input)).toEqual({ ok: true, value });
  });

  it.each([
    "hooks.example.com",
    "http://hooks.example.com",
    "ftp://hooks.example.com",
    "https://hooks.example.com/bb",
    "https://hooks.example.com/?a=1",
    "https://hooks.example.com?",
    "https://hooks.example.com/#top",
    "not a url",
  ])("rejects %j", (input) => {
    expect(normalizeBaseUrl(input)).toEqual({ ok: false, error: BASE_URL_ERROR });
  });
});

describe("buildHookUrl", () => {
  const loopback = "http://127.0.0.1:38886";
  const path = "/api/v1/plugins/bots/http/hook?id=bot_1";

  it("uses the public base first, with loopback as localUrl", () => {
    expect(buildHookUrl("https://hooks.example.com", loopback, "bots", "bot_1")).toEqual({
      url: `https://hooks.example.com${path}`,
      localUrl: `${loopback}${path}`,
      isPublic: true,
    });
  });

  it("falls back to loopback when the public base is null or empty", () => {
    for (const base of [null, ""]) {
      expect(buildHookUrl(base, `${loopback}/`, "bots", "bot_1")).toEqual({
        url: `${loopback}${path}`,
        localUrl: `${loopback}${path}`,
        isPublic: false,
      });
    }
  });

  it("encodes the bot id", () => {
    expect(buildHookUrl(null, loopback, "bots", "a b&c").url).toBe(
      `${loopback}/api/v1/plugins/bots/http/hook?id=a%20b%26c`,
    );
  });

  it("builds the path from the plugin id, not from a fixed one", () => {
    const built = buildHookUrl("https://hooks.example.com", loopback, "bots-livetest", "bot_1");
    expect(built.url).toBe("https://hooks.example.com/api/v1/plugins/bots-livetest/http/hook?id=bot_1");
    expect(built.localUrl).toBe(`${loopback}/api/v1/plugins/bots-livetest/http/hook?id=bot_1`);
  });
});
