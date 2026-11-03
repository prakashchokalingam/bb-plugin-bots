import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { EMOJI_GROUPS, emojiPickerHint, isSingleEmoji, normalizeEmoji } from "@/bots";
import { AVATAR_SHAPES, AVATAR_COLORS, randomAvatar, type BlobAvatar } from "@/bots";
import { BotAvatar } from "@/components/BotAvatar";
import type { ReactNode } from "react";

/**
 * `navigator.userAgentData` isn't in the standard TS DOM lib yet. Type just
 * the bit we read rather than reaching for `any` or a global augmentation
 * that could clash with other declarations.
 */
type NavigatorUAData = { platform?: string };

/** Reads the platform + touch signals used to phrase the OS-picker hint. */
function detectPlatform(): { platform: string; isTouch: boolean } {
  if (typeof navigator === "undefined") {
    return { platform: "", isTouch: false };
  }
  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData })
    .userAgentData;
  const platform = uaData?.platform ?? navigator.platform ?? "";
  const isTouch =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  return { platform, isTouch };
}

export function EmojiPicker({
  value,
  onChange,
  children,
  avatar,
  onAvatarChange,
}: {
  value: string;
  onChange: (emoji: string) => void;
  children: ReactNode;
  avatar: BlobAvatar | null;
  onAvatarChange: (avatar: BlobAvatar | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [shapesOpen, setShapesOpen] = useState(false);
  const shapesRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!shapesOpen) return;
    const onPointer = (event: PointerEvent) => { if (!shapesRef.current?.contains(event.target as Node)) setShapesOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setShapesOpen(false); moreRef.current?.focus(); } };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey, true); };
  }, [shapesOpen]);
  const [tab, setTab] = useState<"blob" | "emoji">(avatar ? "blob" : "emoji");
  const [hex, setHex] = useState(avatar?.color ?? AVATAR_COLORS[0]);
  const active = avatar ?? { version: 1 as const, type: "blob" as const, shape: "round" as const, color: hex };
  const [customValue, setCustomValue] = useState("");

  const normalizedCustom = normalizeEmoji(customValue);
  const { platform, isTouch } = useMemo(detectPlatform, []);
  const hint = useMemo(
    () => emojiPickerHint({ platform, isTouch }),
    [platform, isTouch],
  );

  function pick(emoji: string) {
    onChange(emoji);
    onAvatarChange(null);
    setOpen(false);
  }

  function useCustom() {
    if (normalizedCustom === null) return;
    onChange(normalizedCustom);
    onAvatarChange(null);
    setOpen(false);
  }

  function handleCustomChange(next: string) {
    setCustomValue(next);
    if (isSingleEmoji(next)) {
      // Inserted straight from the OS picker (or typed one glyph) — apply
      // immediately, no explicit "Use" click needed.
      onChange(next.trim());
      onAvatarChange(null);
      setOpen(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setShapesOpen(false);
        if (next) {
          // Custom field always starts blank — it's for entering something
          // new, not for editing the current value.
          setCustomValue("");
          setTab(avatar ? "blob" : "emoji");
          setHex(avatar?.color ?? AVATAR_COLORS[0]);
        }
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose an avatar</DialogTitle>
          <DialogDescription>
            Choose a blob or an emoji.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2" role="group" aria-label="Avatar type">
          <Button type="button" variant={tab === "blob" ? "default" : "outline"} aria-pressed={tab === "blob"} onClick={() => setTab("blob")}>Blob</Button>
          <Button type="button" variant={tab === "emoji" ? "default" : "outline"} aria-pressed={tab === "emoji"} onClick={() => setTab("emoji")}>Emoji</Button>
        </div>
        {tab === "blob" ? <div className="space-y-4">
          <div className="flex items-center gap-3"><BotAvatar botId="preview" emoji={value} avatar={active} size="lg" animated/><span className="text-sm text-muted-foreground">Preview</span></div>
          <fieldset><legend className="text-sm font-medium">Shape</legend>
            <div className="flex gap-2 mt-2 items-center">
              {[...AVATAR_SHAPES.slice(0, 3), avatar && !AVATAR_SHAPES.slice(0, 3).includes(avatar.shape) ? avatar.shape : "cloud" as const].map(shape => <button type="button" key={shape} aria-label={shape} aria-pressed={avatar?.shape === shape} onClick={() => onAvatarChange({ ...active, shape })} className={cn("rounded-lg p-1 hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring", avatar?.shape === shape && "ring-2 ring-ring")}><BotAvatar botId="preview" emoji={value} avatar={{ ...active, shape }}/></button>)}
              <div className="relative" ref={shapesRef}>
                <button ref={moreRef} type="button" aria-label="More shapes" aria-expanded={shapesOpen} aria-controls="more-avatar-shapes" onClick={() => setShapesOpen(value => !value)} className="size-10 rounded-lg border border-border hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring">•••</button>
                {shapesOpen && <div id="more-avatar-shapes" role="group" aria-label="More shapes" className="absolute right-0 top-full z-50 mt-2 grid w-44 grid-cols-3 gap-1 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-md">
                  {AVATAR_SHAPES.map(shape => <button type="button" key={shape} aria-label={shape} aria-pressed={avatar?.shape === shape} onClick={() => { onAvatarChange({ ...active, shape }); setShapesOpen(false); moreRef.current?.focus(); }} className={cn("rounded-lg p-1 hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring", avatar?.shape === shape && "ring-2 ring-ring")}><BotAvatar botId="preview" emoji={value} avatar={{ ...active, shape }}/></button>)}
                </div>}
              </div>
            </div>
          </fieldset>
          <fieldset><legend className="text-sm font-medium">Color</legend><div className="flex items-center gap-2 mt-2 flex-wrap">{AVATAR_COLORS.map(color => <button type="button" key={color} aria-label={`Color ${color}`} aria-pressed={avatar?.color.toLowerCase() === color} onClick={() => { setHex(color); onAvatarChange({ ...active, color }); }} className={cn("size-8 rounded-full border border-border focus-visible:ring-2 focus-visible:ring-ring", avatar?.color.toLowerCase() === color && "ring-2 ring-ring ring-offset-2")} style={{ backgroundColor: color }}>{avatar?.color.toLowerCase() === color ? "✓" : null}</button>)}<label className="text-sm">Custom <input aria-label="Custom color" type="color" value={/^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#a78bfa"} onChange={e => { setHex(e.target.value); onAvatarChange({ ...active, color: e.target.value }); }} /></label></div>
          <label className="block mt-2 text-xs text-muted-foreground">Hex color<Input aria-label="Hex color" value={hex} maxLength={7} onChange={e => { const v = e.target.value; setHex(v); if (/^#[0-9a-fA-F]{6}$/.test(v)) onAvatarChange({ ...active, color: v }); }}/></label></fieldset>
          <Button type="button" variant="outline" onClick={() => { const next = randomAvatar(); setHex(next.color); onAvatarChange(next); }}>Shuffle blob</Button>
        </div> : <>
        <div className="flex flex-col gap-3">
          {EMOJI_GROUPS.map((group) => (
            <div key={group.label} className="flex flex-col gap-1.5">
              <div className="text-xs text-muted-foreground">
                {group.label}
              </div>
              <div className="grid grid-cols-10 gap-1">
                {group.emojis.map((emoji) => {
                  const selected = emoji === value;
                  return (
                    <button
                      key={emoji}
                      type="button"
                      aria-pressed={selected}
                      aria-label={emoji}
                      onClick={() => pick(emoji)}
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-md text-lg hover:bg-state-hover",
                        selected && "bg-state-active ring-1 ring-ring",
                      )}
                    >
                      {emoji}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="emoji-picker-custom" className="text-xs text-muted-foreground">
            Any other emoji
          </label>
          <div className="flex gap-2">
            <Input
              id="emoji-picker-custom"
              value={customValue}
              maxLength={16}
              placeholder="Insert or type an emoji…"
              aria-describedby="emoji-picker-hint"
              onChange={(event) => handleCustomChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  useCustom();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={normalizedCustom === null}
              onClick={useCustom}
            >
              Use
            </Button>
          </div>
          <div id="emoji-picker-hint" className="text-xs text-muted-foreground">
            {hint}
          </div>
        </div>

        </>}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
