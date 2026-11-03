import { useRef, useState } from "react";
import { experimental_useSidebarThreadActions } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { Icon } from "@/components/ui/icon";
import { formatRelative } from "@/components/relative-time";
import { useBotsRpc } from "@/components/use-query";
import { cn } from "@/lib/utils";

const RENAME_LIMIT = 200;

/** The subset of server.ts's ChatSchema a row needs to render and act on. */
export interface RowChat {
  threadId: string;
  title: string | null;
  status: string;
  updatedAt: number;
  pinnedAt: number | null;
  archivedAt: number | null;
}

export function ChatRow({
  chat,
  archived,
  onOpen,
  reload,
}: {
  chat: RowChat;
  /**
   * Archived rows get their own trimmed menu (Unarchive/Delete, no
   * pin/rename) and render dimmed, but stay clickable — BB keeps archived
   * threads readable.
   */
  archived: boolean;
  onOpen: () => void;
  reload: () => void;
}) {
  const rpc = useBotsRpc();
  const actions = experimental_useSidebarThreadActions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(chat.title ?? "");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Same fix as BotHeader's more-actions menu: closing on the trigger's own onBlur
  // fires on mousedown, before a menu item's click ever lands, so every item
  // was dead. Close on the *container's* blur instead, and only when focus
  // actually left the container.
  function onMenuContainerBlur(event: React.FocusEvent<HTMLDivElement>) {
    const next = event.relatedTarget;
    if (next !== null && event.currentTarget.contains(next)) return;
    setMenuOpen(false);
  }

  function onMenuContainerKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    setMenuOpen(false);
    triggerRef.current?.focus();
  }

  function startRename() {
    setDraft(chat.title ?? "");
    setIsEditing(true);
  }

  function cancelRename() {
    setIsEditing(false);
    setDraft(chat.title ?? "");
  }

  async function commitRename() {
    const trimmed = draft.trim().slice(0, RENAME_LIMIT);
    // An empty or unchanged value isn't a rename — treat it as a cancel and
    // fire no RPC at all.
    if (trimmed.length === 0 || trimmed === (chat.title ?? "")) {
      cancelRename();
      return;
    }
    setIsEditing(false);
    try {
      await actions.rename(chat.threadId, trimmed);
      reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function togglePin() {
    setMenuOpen(false);
    actions
      .setPinned(chat.threadId, chat.pinnedAt === null)
      .then(reload)
      .catch((cause: unknown) => {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      });
  }

  function doArchive() {
    setMenuOpen(false);
    try {
      actions.archive(chat.threadId);
      reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function doDelete() {
    setMenuOpen(false);
    // BB's own delete confirmation owns this — it counts child threads
    // first. The SDK deliberately has no silent delete, so this plugin
    // never builds its own confirmation dialog.
    actions.requestDelete(chat.threadId);
  }

  async function doUnarchive() {
    setMenuOpen(false);
    try {
      await rpc.call("unarchiveChat", { threadId: chat.threadId });
      reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const isPinned = chat.pinnedAt !== null;

  return (
    <div
      className={cn(
        "group flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent",
        archived ? "text-muted-foreground opacity-70" : "",
      )}
    >
      {/*
       * The rename <input> is a SIBLING of the navigate button here, never
       * its descendant. An earlier version nested the input inside the
       * navigate <button> and toggled `disabled={isEditing}` on that
       * button to stop it from also firing onOpen. jsdom doesn't enforce
       * either HTML rule this broke, so no test caught it, but in a real
       * browser a disabled ancestor makes ALL of its descendants inert —
       * the input couldn't be focused or typed into, so rename was
       * silently dead in the shipped app. Rendering the button and the
       * input as mutually exclusive children of the row instead (button
       * when not editing, input in its place when editing) sidesteps both
       * that inertness bug and the invalid-HTML problem of nesting
       * interactive content (<input>) inside a <button>.
       */}
      {isEditing ? (
        <input
          ref={inputRef}
          aria-label="Chat title"
          value={draft}
          maxLength={RENAME_LIMIT}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitRename();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelRename();
            }
          }}
          className="min-w-0 flex-1 rounded-sm border border-input bg-transparent px-1 py-0.5 text-sm"
        />
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {isPinned ? (
            <Icon
              name="Pin"
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate">
            {chat.title ?? "New chat"}
          </span>
        </button>
      )}
      <span className="shrink-0 text-xs text-muted-foreground">
        {formatRelative(chat.updatedAt)}
      </span>
      {isEditing ? null : (
        <Icon
          name="ChevronRight"
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
      )}

      {isEditing ? null : (
        <div
          className="relative shrink-0"
          onBlur={onMenuContainerBlur}
          onKeyDown={onMenuContainerKeyDown}
        >
          <button
            ref={triggerRef}
            type="button"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className={cn(
              `${COARSE_POINTER_HEADER_ICON_BUTTON_CLASS} inline-flex items-center justify-center hover:bg-accent`,
              // Hover-revealed on pointer-fine devices, always visible on
              // coarse-pointer/touch — there's no hover affordance there.
              "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-md:pointer-coarse:opacity-100",
            )}
          >
            <Icon name="MoreHorizontal" aria-hidden />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              className="absolute right-0 top-full z-10 mt-1 w-36 rounded-md border border-border bg-popover p-1 shadow-md"
            >
              {archived ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void doUnarchive()}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <Icon name="ArchiveRestore" className="size-4 shrink-0" aria-hidden />
                    Unarchive
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={doDelete}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-destructive hover:bg-accent"
                  >
                    <Icon name="Trash2" className="size-4 shrink-0" aria-hidden />
                    Delete
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={togglePin}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <Icon
                      name={isPinned ? "PinOff" : "Pin"}
                      className="size-4 shrink-0"
                      aria-hidden
                    />
                    {isPinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      startRename();
                    }}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <Icon name="Edit" className="size-4 shrink-0" aria-hidden />
                    Rename
                  </button>
                  <div className="my-1 h-px bg-border" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={doArchive}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <Icon name="Archive" className="size-4 shrink-0" aria-hidden />
                    Archive
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={doDelete}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-destructive hover:bg-accent"
                  >
                    <Icon name="Trash2" className="size-4 shrink-0" aria-hidden />
                    Delete
                  </button>
                </>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
