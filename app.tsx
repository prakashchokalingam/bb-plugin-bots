// bb-plugin-bots — frontend entry.
//
// A persistent left rail of bots (BotRail) beside a content pane. The chat
// pane is BB's own ThreadChat component, so this plugin never reimplements a
// composer or a timeline.
import { useEffect, useState, type ReactNode } from "react";
import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { parseRoute } from "@/bots";
import { BotChatView } from "@/components/BotChatView";
import { BotEditor } from "@/components/BotEditor";
import { BotHome } from "@/components/BotHome";
import { BotRail } from "@/components/BotRail";
import { PANEL_PATH } from "@/components/panel-path";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Icon } from "@/components/ui/icon";
import { useBotsRpc } from "@/components/use-query";

/** A document-style pane (root empty state, transient create, the editor). */
function DocumentPane({
  onBack,
  children,
}: {
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {onBack === undefined ? null : (
        <div className="flex shrink-0 items-center border-b border-border px-4 py-2">
          <button
            type="button"
            aria-label="Back"
            onClick={onBack}
            className={`${COARSE_POINTER_HEADER_ICON_BUTTON_CLASS} inline-flex items-center justify-center hover:bg-accent`}
          >
            <Icon name="ChevronLeft" aria-hidden />
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        <div className="mx-auto w-full max-w-3xl">{children}</div>
      </div>
    </div>
  );
}

function BotsPanel({ subPath }: PluginNavPanelProps) {
  const route = parseRoute(subPath);
  const rpc = useBotsRpc();
  const navigate = useBbNavigate();
  const isCompact = useIsCompactViewport();
  const [isCreatingDraft, setIsCreatingDraft] = useState(false);

  // "new" is a transient route, not a real screen: create a draft row
  // immediately and replace-navigate into its editor. BotEditor's `botId`
  // prop is non-null, so nothing here ever mounts it without a real id.
  useEffect(() => {
    if (route.view !== "new" || isCreatingDraft) return;
    setIsCreatingDraft(true);
    rpc
      .call("createBot", null)
      .then((created) => {
        navigate.toPluginPanel(PANEL_PATH, {
          subPath: `${created.botId}/edit`,
          replace: true,
        });
      })
      .catch((cause) => {
        toast.error(cause instanceof Error ? cause.message : String(cause));
        navigate.toPluginPanel(PANEL_PATH, { subPath: "", replace: true });
      })
      .finally(() => setIsCreatingDraft(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.view]);

  const selectedBotId =
    route.view === "list" || route.view === "new" ? null : route.botId;
  const goToRoot = () => navigate.toPluginPanel(PANEL_PATH, { subPath: "" });
  const onBack = isCompact ? goToRoot : undefined;

  let content: ReactNode;
  switch (route.view) {
    case "list":
      content = (
        <DocumentPane>
          <p className="p-6 text-center text-sm text-muted-foreground">
            Pick a bot to get started.
          </p>
        </DocumentPane>
      );
      break;
    case "new":
      content = (
        <DocumentPane>
          <p className="p-6 text-center text-sm text-muted-foreground">
            Setting up your bot…
          </p>
        </DocumentPane>
      );
      break;
    case "edit":
      content = (
        <DocumentPane onBack={onBack}>
          <BotEditor botId={route.botId} />
        </DocumentPane>
      );
      break;
    case "bot":
    case "newChat":
      content = <BotHome botId={route.botId} onBack={onBack} />;
      break;
    case "chat":
      content = (
        <BotChatView
          botId={route.botId}
          threadId={route.threadId}
          onBack={onBack}
        />
      );
      break;
  }

  // One pane at a time on a compact viewport: the rail alone at the root,
  // the content pane alone (with its own back affordance) once a bot is
  // selected. Both panes own their own scrolling, so neither can produce a
  // double scrollbar.
  if (isCompact) {
    return (
      <div className="h-full min-h-0">
        {selectedBotId === null && route.view !== "new" ? (
          <BotRail selectedBotId={null} />
        ) : (
          content
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <BotRail selectedBotId={selectedBotId} selectedThreadId={route.view === "chat" ? route.threadId : null} />
      <div className="min-h-0 flex-1">{content}</div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "bots",
    title: "Bots",
    icon: "Bot",
    path: PANEL_PATH,
    component: BotsPanel,
  });
});
