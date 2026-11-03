import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
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
  hookRpcMethods,
  type HookState,
} from "@/hook-contract";

/** Same idle time as the editor's own autosave. */
export const HOOK_AUTOSAVE_DELAY_MS = 600;

const MASKED_SECRET = `${HOOK_SECRET_PREFIX}••••••••`;

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

  // The latest server view of the hook (URL, public flag, version). Editable
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

          <div className="space-y-2">
            <Label htmlFor="bot-webhook-url">URL</Label>
            <div className="flex items-center gap-2">
              <Input id="bot-webhook-url" value={hook.url} readOnly className="font-mono text-xs" />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void copyText(hook.url, "URL")}
              >
                Copy
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void copyText(hook.localUrl, "Local URL")}
              >
                Copy local
              </Button>
            </div>
            {hook.isPublic ? null : (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon name="AlertTriangle" className="size-3.5 shrink-0" aria-hidden />
                <span>
                  Local only. Set &quot;Public base URL&quot; in Settings → Installed plugins →
                  Bots.
                </span>
              </p>
            )}
          </div>

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
            onClick={() => void copyText(curlExample(hook.url), "curl example")}
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
