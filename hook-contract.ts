// Shared contract for the bot webhook. Server (server.ts, hook.ts) and UI
// (components/BotEditor.tsx) both import from here. Do not change a name or a
// shape without updating docs/webhook-spec.md.
import { z } from "zod";

// ── Wire constants ───────────────────────────────────────────────────────────
export const HOOK_ROUTE_PATH = "/hook";
export const HOOK_HEADER_TIMESTAMP = "x-hook-timestamp";
export const HOOK_HEADER_SIGNATURE = "x-hook-signature";
export const HOOK_HEADER_IDEMPOTENCY = "idempotency-key";
export const HOOK_SIGNATURE_PREFIX = "sha256=";
export const HOOK_SECRET_PREFIX = "whsec_";

// ── Limits ───────────────────────────────────────────────────────────────────
export const HOOK_MAX_BODY_BYTES = 256 * 1024;
export const HOOK_TIMESTAMP_SKEW_SECONDS = 300;
export const HOOK_DEFAULT_RATE_LIMIT_PER_MIN = 10;
export const HOOK_RATE_LIMIT_MIN = 1;
export const HOOK_RATE_LIMIT_MAX = 600;
export const HOOK_SEEN_RETENTION_MS = 24 * 60 * 60 * 1000;
export const HOOK_CLAIM_STALE_MS = 60 * 1000;

// Fixed in code, never a setting. `accept-edits` is the most restrictive value
// of the SDK's permission enum ("accept-edits" | "auto" | "full").
export const HOOK_PERMISSION_MODE = "accept-edits" as const;

// ── RPC shapes ───────────────────────────────────────────────────────────────
export const HookStateSchema = z.object({
  botId: z.string(),
  enabled: z.boolean(),
  rateLimitPerMin: z
    .number()
    .int()
    .min(HOOK_RATE_LIMIT_MIN)
    .max(HOOK_RATE_LIMIT_MAX),
  secretVersion: z.number().int().min(1),
  // Full URL a caller posts to. Uses `publicBaseUrl` when set, else loopback.
  url: z.string(),
  // Always the loopback URL, for scripts on this machine.
  localUrl: z.string(),
  // True when `url` is built from `publicBaseUrl`. False means "local only".
  isPublic: z.boolean(),
});
export type HookState = z.infer<typeof HookStateSchema>;

// Spread these into the existing `defineRpcContract({ ... })` in server.ts.
export const hookRpcMethods = {
  getHook: {
    input: z.object({ botId: z.string() }).strict(),
    output: z.object({ hook: HookStateSchema }),
  },
  saveHook: {
    input: z
      .object({
        botId: z.string(),
        enabled: z.boolean(),
        rateLimitPerMin: z
          .number()
          .int()
          .min(HOOK_RATE_LIMIT_MIN)
          .max(HOOK_RATE_LIMIT_MAX),
      })
      .strict(),
    output: z.object({ hook: HookStateSchema }),
  },
  // Derives the secret again. Does not change it.
  revealSecret: {
    input: z.object({ botId: z.string() }).strict(),
    output: z.object({ secret: z.string() }),
  },
  // secretVersion + 1. The old secret stops working at once.
  rotateSecret: {
    input: z.object({ botId: z.string() }).strict(),
    output: z.object({ secret: z.string(), hook: HookStateSchema }),
  },
} as const;
