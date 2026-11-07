import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useQuery } from "@/components/use-query";
import {
  HOOK_RATE_LIMIT_MAX,
  HOOK_RATE_LIMIT_MIN,
  HOOK_SECRET_PREFIX,
  LISTENER_PORT_MAX,
  LISTENER_PORT_MIN,
  LISTENER_REASON_PORT_IN_USE,
  LISTENER_REASON_PORT_INVALID,
  LISTENER_REASON_STARTING,
  hookRpcMethods,
  type HookState,
} from "@/hook-contract";

/** Same idle time as the editor's own autosave. */
export const HOOK_AUTOSAVE_DELAY_MS = 600;

const MASKED_SECRET = `${HOOK_SECRET_PREFIX}••••••••`;

/** While the listener is still binding, ask again this often, this many times. */
const LISTENER_POLL_MS = 1000;
const LISTENER_POLL_MAX = 10;

export interface StatusLine {
  /** "ok" is the green running state, "idle" is neutral, "warn" needs action. */
  tone: "ok" | "idle" | "warn";
  glyph: "●" | "○" | "⚠";
  text: string;
}

/**
 * The listener status line. One line per state: running, no base URL, draft
 * bot, port in use. A base URL that was ignored gets its own line, because it
 * can sit next to any of the others.
 */
export function listenerStatusLines(hook: HookState, isDraft: boolean): StatusLine[] {
  const lines: StatusLine[] = [];
  const { listener } = hook;
  if (isDraft) {
    lines.push({ tone: "idle", glyph: "○", text: "Publish this bot to receive webhooks" });
  } else if (listener.state === "running") {
    lines.push({
      tone: "ok",
      glyph: "●",
      text: `Listening on 127.0.0.1:${listener.port} — point your tunnel here`,
    });
  } else if (listener.state === "error") {
    const text =
      listener.reason === LISTENER_REASON_PORT_IN_USE
        ? `Port ${listener.port} is in use — choose another port in plugin settings`
        : listener.reason === LISTENER_REASON_PORT_INVALID
          ? `The listener port must be a whole number from ${LISTENER_PORT_MIN} to ${LISTENER_PORT_MAX} — change it in plugin settings`
          : `The listener could not start — ${listener.reason ?? "unknown error"}`;
    lines.push({ tone: "warn", glyph: "⚠", text });
  } else if (listener.reason === LISTENER_REASON_STARTING) {
    lines.push({ tone: "idle", glyph: "○", text: "Starting the listener…" });
  } else if (hook.urls.length === 0) {
    lines.push({ tone: "idle", glyph: "○", text: "Stopped — add a base URL in plugin settings" });
  } else {
    lines.push({ tone: "idle", glyph: "○", text: "Stopped" });
  }
  for (const entry of hook.ignoredBaseUrls) {
    lines.push({
      tone: "warn",
      glyph: "⚠",
      text: `"${entry}" ignored — use a full URL that starts with https://`,
    });
  }
  return lines;
}

const TONE_CLASS: Record<StatusLine["tone"], string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  idle: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
};

/**
 * The shell snippet behind "Copy curl example". It always carries a
 * placeholder secret, never the real one: a copied snippet ends up in chat
 * logs and terminals, and the real secret only leaves via Reveal or Copy.
 */
export function curlExample(url: string): string {
  return [
    `URL='${url}'`,
    `SECRET='${HOOK_SECRET_PREFIX}REPLACE_ME'   # use Reveal in the bot editor`,
    `BODY='{"text":"hello"}'`,
    `TS=$(date +%s)`,
    `SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')`,
    `curl -X POST "$URL" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "X-Hook-Timestamp: $TS" \\`,
    `  -H "X-Hook-Signature: sha256=$SIG" \\`,
    `  -H "Idempotency-Key: $(uuidgen)" \\`,
    `  -d "$BODY"`,
  ].join("\n");
}

/** Keeps a typed rate inside the contract bounds; null when it is not a number. */
function clampRate(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(HOOK_RATE_LIMIT_MAX, Math.max(HOOK_RATE_LIMIT_MIN, parsed));
}

async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : String(cause));
  }
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function BotWebhook({ botId, isDraft }: { botId: string; isDraft: boolean }) {
  // Typed straight from the shared contract, so this section does not depend
  // on how server.ts composes its full RPC contract.
  const rpc = useRpc<typeof hookRpcMethods>();
  const { data, error } = useQuery(() => rpc.call("getHook", { botId }), `hook:${botId}`);

  // The latest server view of the hook (URLs, listener, version). Editable
  // fields below are seeded from it once and then owned by the form.
  const [hook, setHook] = useState<HookState | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [rateText, setRateText] = useState("");
  const [isSeeded, setIsSeeded] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [isRevealed, setIsRevealed] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [rotateDialogOpen, setRotateDialogOpen] = useState(false);

  // The last values the server confirmed, so autosave only sends real changes.
  const savedRef = useRef<{ enabled: boolean; rateLimitPerMin: number } | null>(null);
  const draftRef = useRef({ enabled, rateText });
  draftRef.current = { enabled, rateText };
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  useEffect(() => {
    if (data === null) return;
    setHook(data.hook);
    if (isSeeded) return;
    setEnabled(data.hook.enabled);
    setRateText(String(data.hook.rateLimitPerMin));
    savedRef.current = {
      enabled: data.hook.enabled,
      rateLimitPerMin: data.hook.rateLimitPerMin,
    };
    setIsSeeded(true);
  }, [data, isSeeded]);

  // The listener can still be binding when a save returns (a reload briefly
  // leaves the old port holder in place). Ask again until it settles.
  const pollCountRef = useRef(0);
  useEffect(() => {
    if (hook === null || hook.listener.reason !== LISTENER_REASON_STARTING) {
      pollCountRef.current = 0;
      return;
    }
    if (pollCountRef.current >= LISTENER_POLL_MAX) return;
    const timer = setTimeout(() => {
      pollCountRef.current += 1;
      rpc
        .call("getHook", { botId })
        .then((result) => {
          if (mountedRef.current) setHook(result.hook);
        })
        .catch(() => undefined);
    }, LISTENER_POLL_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hook, botId]);

  // Sends the form's values when they differ from the last confirmed save.
  // An unparsable rate keeps the saved one, so a half-typed field never
  // turns the hook off or sends a value outside the contract bounds.
  async function runSave(): Promise<void> {
    const base = savedRef.current;
    if (base === null) return;
    const next = {
      enabled: draftRef.current.enabled,
      rateLimitPerMin: clampRate(draftRef.current.rateText) ?? base.rateLimitPerMin,
    };
    if (next.enabled === base.enabled && next.rateLimitPerMin === base.rateLimitPerMin) {
      return;
    }
    try {
      const result = await rpc.call("saveHook", { botId, ...next });
      savedRef.current = {
        enabled: result.hook.enabled,
        rateLimitPerMin: result.hook.rateLimitPerMin,
      };
      if (mountedRef.current) setHook(result.hook);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  function flushPendingSave(): void {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void runSave();
  }

  // The toggle saves at once; the rate field waits for typing to stop.
  useEffect(() => {
    if (!isSeeded) return;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void runSave();
    }, HOOK_AUTOSAVE_DELAY_MS);
    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSeeded, rateText]);

  useEffect(() => {
    if (!isSeeded) return;
    flushPendingSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSeeded, enabled]);

  // Leaving the editor right after typing must not drop the new rate.
  useEffect(() => {
    window.addEventListener("blur", flushPendingSave);
    return () => {
      window.removeEventListener("blur", flushPendingSave);
      flushPendingSave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadSecret(): Promise<string | null> {
    if (secret !== null) return secret;
    try {
      const result = await rpc.call("revealSecret", { botId });
      if (mountedRef.current) setSecret(result.secret);
      return result.secret;
    } catch (cause) {
      toast.error(errorText(cause));
      return null;
    }
  }

  async function toggleReveal() {
    if (isRevealed) {
      setIsRevealed(false);
      return;
    }
    setIsBusy(true);
    const value = await loadSecret();
    if (mountedRef.current) {
      if (value !== null) setIsRevealed(true);
      setIsBusy(false);
    }
  }

  async function copySecret() {
    const value = await loadSecret();
    if (value !== null) await copyText(value, "Secret");
  }

  async function rotate() {
    setIsBusy(true);
    try {
      const result = await rpc.call("rotateSecret", { botId });
      if (!mountedRef.current) return;
      setHook(result.hook);
      setSecret(result.secret);
      setIsRevealed(true);
      toast.success("Secret rotated");
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  return (
    <section aria-labelledby="bot-webhook-heading" className="space-y-4 border-t border-border pt-5">
      <h3 id="bot-webhook-heading" className="text-sm font-medium">
        Webhook
      </h3>

      {error !== null ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : hook === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {isDraft ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
              Publish this bot to activate its webhook.
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <input
              id="bot-webhook-enabled"
              type="checkbox"
              className="size-4 cursor-pointer accent-foreground"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <Label htmlFor="bot-webhook-enabled">Enabled</Label>
          </div>

          {hook.enabled ? (
            <div role="status" className="space-y-1 text-xs">
              {listenerStatusLines(hook, isDraft).map((line) => (
                <p key={line.text} className={`flex items-start gap-1.5 ${TONE_CLASS[line.tone]}`}>
                  <span aria-hidden>{line.glyph}</span>
                  <span>{line.text}</span>
                </p>
              ))}
            </div>
          ) : null}

          {hook.urls.length > 0 ? (
            <div className="space-y-2">
              <Label>URLs</Label>
              {hook.urls.map((url) => (
                <div key={url} className="flex items-center gap-2">
                  <Input
                    value={url}
                    readOnly
                    aria-label={`Webhook URL ${url}`}
                    className="font-mono text-xs"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`Copy ${url}`}
                    onClick={() => void copyText(url, "URL")}
                  >
                    Copy
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="bot-webhook-secret">Secret</Label>
            <div className="flex items-center gap-2">
              <Input
                id="bot-webhook-secret"
                value={isRevealed && secret !== null ? secret : MASKED_SECRET}
                readOnly
                className="font-mono text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isBusy}
                aria-pressed={isRevealed}
                onClick={() => void toggleReveal()}
              >
                {isRevealed ? "Hide" : "Reveal"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isBusy}
                aria-label="Copy secret"
                onClick={() => void copySecret()}
              >
                Copy
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isBusy}
                onClick={() => setRotateDialogOpen(true)}
              >
                Rotate
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bot-webhook-rate">Rate limit</Label>
            <div className="flex items-center gap-2">
              <Input
                id="bot-webhook-rate"
                type="number"
                inputMode="numeric"
                min={HOOK_RATE_LIMIT_MIN}
                max={HOOK_RATE_LIMIT_MAX}
                step={1}
                value={rateText}
                className="w-24"
                onChange={(event) => setRateText(event.target.value)}
                onBlur={() => {
                  const clamped = clampRate(rateText);
                  setRateText(String(clamped ?? savedRef.current?.rateLimitPerMin ?? ""));
                }}
              />
              <span className="text-sm text-muted-foreground">/ min</span>
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={hook.primaryUrl === null}
            onClick={() => {
              if (hook.primaryUrl !== null) {
                void copyText(curlExample(hook.primaryUrl), "curl example");
              }
            }}
          >
            Copy curl example
          </Button>

          {/* Rotating breaks every caller that holds the old secret, so it
              always goes through this confirmation. */}
          <Dialog open={rotateDialogOpen} onOpenChange={setRotateDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Rotate the webhook secret?</DialogTitle>
                <DialogDescription>The old secret stops working at once.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setRotateDialogOpen(false);
                    void rotate();
                  }}
                >
                  Rotate secret
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </section>
  );
}
