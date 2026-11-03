import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useBbNavigate, experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { Icon } from "@/components/ui/icon";
import { formatRelative, useRelativeClock } from "@/components/relative-time";
import { BotAvatar } from "@/components/BotAvatar";
import { useBotsRpc, useQuery } from "@/components/use-query";
import { PANEL_PATH } from "@/components/panel-path";
import { cn } from "@/lib/utils";
import { displayName, previewInstructions } from "@/bots";

const WIDTH_KEY = "bots:rail:width";
const EXPANDED_KEY = "bots:rail:expanded";
const MIN_WIDTH = 220;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 260;

/**
 * localStorage itself — not just its contents — can't be trusted: some test
 * and embedded-webview environments provide a `window.localStorage` whose
 * methods throw or are missing entirely. Every read/write goes through these
 * so a storage failure degrades to "nothing persisted", never a crash.
 */
function safeGetItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Persistence is a nice-to-have; losing it silently beats crashing.
  }
}

function readStoredWidth(): number {
  const raw = safeGetItem(WIDTH_KEY);
  const parsed = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed));
}

function readExpanded(): string[] {
  try {
    const value = JSON.parse(safeGetItem(EXPANDED_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

function indicatorStyle(indicator: string, status: string): { label: string; className: string } {
  switch (indicator) {
    case "waiting-for-input": return { label: "Needs input", className: "bg-warning" };
    case "unread-error": return { label: "Unread error", className: "bg-destructive" };
    case "unread-success": return { label: "Unread result", className: "bg-success" };
    case "runtime": case "background-agent": case "background-command": case "workflow": case "goal": case "plan-mode": case "working-draft":
      return { label: "Working", className: "bg-primary motion-safe:animate-pulse" };
    case "none": return { label: "Idle", className: "bg-muted-foreground" };
    default:
      if (status === "error") return { label: "Error", className: "bg-destructive" };
      if (status === "active" || status === "starting" || status === "stopping") return { label: status === "active" ? "Working" : status, className: "bg-primary motion-safe:animate-pulse" };
      return { label: "Idle", className: "bg-muted-foreground" };
  }
}

export function BotRail({ selectedBotId, selectedThreadId = null }: { selectedBotId: string | null; selectedThreadId?: string | null }) {
  useRelativeClock();
  const rpc = useBotsRpc();
  const navigate = useBbNavigate();
  const live = experimental_useSidebarThreads();
  const [expanded, setExpanded] = useState<string[]>(readExpanded);
  function toggleExpanded(id: string) {
    setExpanded(current => { const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id]; safeSetItem(EXPANDED_KEY, JSON.stringify(next)); return next; });
  }
  const { data, error } = useQuery(() => rpc.call("listRail", null), "rail");
  const [width, setWidth] = useState<number>(() => readStoredWidth());
  const [isCreating, setIsCreating] = useState(false);
  const [menuBotId, setMenuBotId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  async function deleteBot() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await rpc.call("deleteBot", { botId: deleteTarget.id });
      if (selectedBotId === deleteTarget.id) navigate.toPluginPanel(PANEL_PATH, { subPath: "", replace: true });
      toast.success(`Deleted ${deleteTarget.name}`);
      setDeleteTarget(null);
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDeleting(false); }
  }

  // Kept for the resize handle only; nothing here reads the node itself.
  const dragOrigin = useRef<{ startX: number; startWidth: number } | null>(null);

  async function createBot() {
    setIsCreating(true);
    try {
      const created = await rpc.call("createBot", null);
      navigate.toPluginPanel(PANEL_PATH, { subPath: `${created.botId}/edit` });
    } finally {
      setIsCreating(false);
    }
  }

  // Drag-resize on the trailing edge — plain pointer events, no library.
  function onResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    dragOrigin.current = { startX: event.clientX, startWidth: width };

    function onMove(moveEvent: PointerEvent) {
      const origin = dragOrigin.current;
      if (origin === null) return;
      const next = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, origin.startWidth + moveEvent.clientX - origin.startX),
      );
      setWidth(next);
    }
    function onUp(upEvent: PointerEvent) {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const origin = dragOrigin.current;
      dragOrigin.current = null;
      if (origin === null) return;
      const finalWidth = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, origin.startWidth + upEvent.clientX - origin.startX),
      );
      safeSetItem(WIDTH_KEY, String(finalWidth));
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const bots = data?.bots ?? [];

  return (
    <div
      style={{ width }}
      className="relative flex h-full min-h-0 shrink-0 flex-col border-r border-border"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-medium">Bots</h2>
        <button
          type="button"
          aria-label={isCreating ? "Creating…" : "New bot"}
          disabled={isCreating}
          onClick={() => void createBot()}
          className={`${COARSE_POINTER_HEADER_ICON_BUTTON_CLASS} inline-flex items-center justify-center hover:bg-accent disabled:opacity-50`}
        >
          <Icon name="Plus" className="size-4 shrink-0" aria-hidden />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error !== null ? (
          <p className="p-3 text-sm text-destructive">{error}</p>
        ) : bots.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-sm text-muted-foreground">No bots yet.</p>
            <Button
              size="sm"
              className="mt-2"
              disabled={isCreating}
              onClick={() => void createBot()}
            >
              New bot
            </Button>
          </div>
        ) : (
          <ul>
            {bots.map((bot) => {
              const isSelected = bot.id === selectedBotId;
              const isDraft = bot.status === "draft";
              const isExpanded = expanded.includes(bot.id);
              const chats = bot.chats.map(chat => {
                const thread = live.threads.find(item => item.id === chat.threadId);
                return { ...chat, title: thread?.title ?? thread?.titleFallback ?? chat.title, updatedAt: thread?.updatedAt ?? chat.updatedAt, indicator: thread?.indicator ?? "unavailable", indicatorLabel: thread?.indicatorLabel ?? null, archived: thread?.isArchived ?? false };
              }).filter(chat => !chat.archived).sort((a, b) => b.updatedAt - a.updatedAt);
              const newestChat = chats[0];
              const secondary =
                newestChat === undefined
                  ? previewInstructions(bot.instructions)
                  : newestChat.title ?? "New chat";

              return (
                <li key={bot.id} className="relative" onKeyDown={event => { if (event.key === "Escape" && menuBotId === bot.id) { event.stopPropagation(); setMenuBotId(null); } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuBotId(null); }}>
                  <div
                    onContextMenu={event => { event.preventDefault(); setMenuBotId(bot.id); }}
                    className={cn(
                      "group relative mx-1 mt-1 flex items-stretch rounded-lg transition-colors hover:bg-accent/60",
                      isSelected && !selectedThreadId ? "bg-accent" : "",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (chats.length > 0) toggleExpanded(bot.id);
                        navigate.toPluginPanel(PANEL_PATH, { subPath: bot.id });
                      }}
                      aria-expanded={chats.length > 0 ? isExpanded : undefined}
                      className={cn(
                        "bot-rail-trigger flex min-w-0 flex-1 items-center gap-2.5 rounded-l-lg px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isDraft ? "text-muted-foreground" : "",
                      )}
                    >
                      <BotAvatar botId={bot.id} emoji={bot.emoji} avatar={bot.avatar} size="sm" animateOnHover />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium">
                            {displayName(bot)}
                          </span>
                          {isDraft ? (
                            <Badge
                              variant="outline"
                              className="shrink-0 px-1 py-0 text-[10px]"
                            >
                              DRAFT
                            </Badge>
                          ) : null}
                        </span>
                        {!isExpanded && <span className="block truncate text-xs text-muted-foreground">
                          {secondary}
                        </span>}
                      </span>
                    </button>
                    <div className="absolute right-8 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-accent px-0.5 opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 max-md:pointer-coarse:pointer-events-auto max-md:pointer-coarse:opacity-100">
                      <button type="button" aria-label={`Edit ${displayName(bot)}`} onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: `${bot.id}/edit` })} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Icon name="Edit" className="size-4 shrink-0" aria-hidden /></button>
                      <button type="button" aria-label={`New thread for ${displayName(bot)}`} onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: `${bot.id}/${isDraft ? "edit" : "new"}` })} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Icon name="Plus" className="size-4 shrink-0" aria-hidden /></button>
                      <button type="button" aria-label={`More actions for ${displayName(bot)}`} aria-haspopup="menu" aria-expanded={menuBotId === bot.id} onClick={() => setMenuBotId(menuBotId === bot.id ? null : bot.id)} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Icon name="MoreHorizontal" className="size-4 shrink-0" aria-hidden /></button>
                    </div>
                    {chats.length > 0 && <button type="button" aria-label={`${isExpanded ? "Collapse" : "Expand"} ${displayName(bot)} threads`} aria-expanded={isExpanded} onClick={() => toggleExpanded(bot.id)} className="mr-1 my-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Icon name={isExpanded ? "ChevronDown" : "ChevronRight"} className="size-4 shrink-0" aria-hidden /></button>}
                  </div>
                  {menuBotId === bot.id && <div role="menu" aria-label={`${displayName(bot)} actions`} className="absolute right-2 top-12 z-50 w-36 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
                    <button type="button" role="menuitem" autoFocus onClick={() => { setMenuBotId(null); setDeleteTarget({ id: bot.id, name: displayName(bot) }); }} className="w-full rounded-sm px-2 py-1.5 text-left text-sm text-destructive hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">Delete bot</button>
                  </div>}
                  {isExpanded && chats.length > 0 && <ul className="ml-[25px] mr-1 border-l border-border/70 pl-3 pb-1" aria-label={`${displayName(bot)} recent threads`}>
                    {chats.slice(0, 3).map(chat => {
                      const state = indicatorStyle(chat.indicator, chat.status);
                      const stateLabel = chat.indicatorLabel ?? state.label;
                      return <li key={chat.threadId}><button type="button" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: `${bot.id}/${chat.threadId}` })} aria-current={selectedThreadId === chat.threadId ? "page" : undefined} className={cn("flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selectedThreadId === chat.threadId && "bg-accent font-medium text-foreground") }>
                        <span title={stateLabel} aria-label={stateLabel} role="img" className={cn("size-2 shrink-0 rounded-full", state.className)} />
                        <span className="min-w-0 flex-1 truncate">{chat.title ?? "New chat"}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(chat.updatedAt)}</span>
                      </button></li>;
                    })}
                    {chats.length > 3 && <li><button type="button" className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: bot.id })}>View all threads <span aria-hidden="true">→</span></button></li>}
                  </ul>}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog open={deleteTarget !== null} onOpenChange={open => { if (!open && !deleting) setDeleteTarget(null); }}>
        <DialogContent><DialogHeader><DialogTitle>Delete {deleteTarget?.name}?</DialogTitle><DialogDescription>Its chats stay in BB but stop following these instructions.</DialogDescription></DialogHeader>
          <DialogFooter><DialogClose asChild><Button variant="outline" disabled={deleting}>Cancel</Button></DialogClose><Button variant="destructive" disabled={deleting} onClick={() => void deleteBot()}>{deleting ? "Deleting…" : "Delete"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <div
        onPointerDown={onResizePointerDown}
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize touch-none select-none"
      />
    </div>
  );
}
