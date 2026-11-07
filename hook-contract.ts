// Shared contract for the bot webhook. Server (server.ts, hook.ts) and UI
// (components/BotEditor.tsx) both import from here. Do not change a name or a
// shape without updating docs/webhook-spec.md.
import { z } from "zod";

// ── Wire constants ───────────────────────────────────────────────────────────
// The listener serves one path per bot: POST /hooks/<botId>.
export const HOOK_PATH_PREFIX = "/hooks/";
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

// ── Listener ─────────────────────────────────────────────────────────────────
// The plugin setting is a string because SDK 0.4.8 has no number type.
export const DEFAULT_LISTENER_PORT = "38990";
export const LISTENER_PORT_MIN = 1024;
export const LISTENER_PORT_MAX = 65535;
export const LISTENER_MAX_CONNECTIONS = 64;
export const LISTENER_HEADERS_TIMEOUT_MS = 10 * 1000;
export const LISTENER_REQUEST_TIMEOUT_MS = 30 * 1000;
export const LISTENER_KEEP_ALIVE_TIMEOUT_MS = 5 * 1000;
// `listener.reason` values the UI turns into its own text. Any other reason is
// shown as given.
export const LISTENER_REASON_PORT_IN_USE = "port-in-use";
export const LISTENER_REASON_PORT_INVALID = "port-invalid";
export const LISTENER_REASON_STARTING = "starting";

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
  // One URL per valid entry of the `allowedBaseUrls` setting:
  // base + "/hooks/" + botId.
  urls: z.array(z.string()),
  // The first entry of `urls`, or null when no base URL is valid.
  primaryUrl: z.string().nullable(),
  // Entries of `allowedBaseUrls` that were ignored because they are not valid.
  ignoredBaseUrls: z.array(z.string()),
  listener: z.object({
    // "stopped" with reason "starting" means the bind is being retried.
    state: z.enum(["running", "stopped", "error"]),
    // The configured listener port.
    port: z.number().int(),
    reason: z.string().nullable(),
  }),
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
