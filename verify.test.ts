import { describe, expect, it } from "vitest";
import {
  BASE_URL_ERROR,
  buildHookUrls,
  deriveSecret,
  normalizeBaseUrl,
  parseAllowedBaseUrls,
  parseListenerPort,
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

describe("parseAllowedBaseUrls", () => {
  it("returns nothing for an empty or blank setting", () => {
    for (const text of ["", "   ", ",", " , ,"]) {
      expect(parseAllowedBaseUrls(text)).toEqual({ urls: [], hosts: [], invalid: [] });
    }
  });

  it("reads comma-separated entries in order, with their hosts", () => {
    expect(
      parseAllowedBaseUrls("https://hooks.you.com, http://127.0.0.1:38990/ ,https://b.example.com:8443"),
    ).toEqual({
      urls: ["https://hooks.you.com", "http://127.0.0.1:38990", "https://b.example.com:8443"],
      hosts: ["hooks.you.com", "127.0.0.1:38990", "b.example.com:8443"],
      invalid: [],
    });
  });

  it("allows http only for 127.0.0.1 and localhost", () => {
    const parsed = parseAllowedBaseUrls("http://localhost:3000,http://hooks.you.com");
    expect(parsed.urls).toEqual(["http://localhost:3000"]);
    expect(parsed.invalid).toEqual(["http://hooks.you.com"]);
  });

  it("reports an entry that is not valid and keeps the others", () => {
    expect(
      parseAllowedBaseUrls("hooks.you.com, https://ok.example.com, https://x.example.com/path, https://y.example.com?a=1"),
    ).toEqual({
      urls: ["https://ok.example.com"],
      hosts: ["ok.example.com"],
      invalid: ["hooks.you.com", "https://x.example.com/path", "https://y.example.com?a=1"],
    });
  });

  it("lower-cases the host and drops a repeated entry", () => {
    expect(parseAllowedBaseUrls("https://Hooks.You.com,https://hooks.you.com/")).toEqual({
      urls: ["https://hooks.you.com"],
      hosts: ["hooks.you.com"],
      invalid: [],
    });
  });

  it("drops the default https port from the host", () => {
    expect(parseAllowedBaseUrls("https://hooks.you.com:443").hosts).toEqual(["hooks.you.com"]);
  });
});

describe("buildHookUrls", () => {
  it("builds <base>/hooks/<botId> for each base, in order", () => {
    expect(
      buildHookUrls(["https://hooks.you.com", "http://127.0.0.1:38990"], "bot_0123456789abcdef"),
    ).toEqual([
      "https://hooks.you.com/hooks/bot_0123456789abcdef",
      "http://127.0.0.1:38990/hooks/bot_0123456789abcdef",
    ]);
  });

  it("returns an empty list for no bases", () => {
    expect(buildHookUrls([], "bot_0123456789abcdef")).toEqual([]);
  });
});

describe("parseListenerPort", () => {
  it.each([
    ["38990", 38990],
    [" 1024 ", 1024],
    ["65535", 65535],
  ])("accepts %j", (text, port) => {
    expect(parseListenerPort(text)).toBe(port);
  });

  it.each(["", "1023", "65536", "0", "-1", "38990.5", "abc", "38 990", "99999999"])(
    "rejects %j",
    (text) => {
      expect(parseListenerPort(text)).toBeNull();
    },
  );
});
