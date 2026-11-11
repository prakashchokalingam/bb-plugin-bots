// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { EMOJIS } from "./bots";
import { HOOK_RATE_LIMIT_MAX, type HookState } from "./hook-contract";
import { formatRelative } from "./components/relative-time";

describe("relative timestamps", () => {
  it("uses compact relative units for older dates", () => {
    const now = Date.now();
    const day = 86_400_000;
    expect(formatRelative(now - 8 * day)).toBe("1w");
    expect(formatRelative(now - 45 * day)).toBe("1mo");
    expect(formatRelative(now - 400 * day)).toBe("1y");
    expect(formatRelative(now + day)).toBe("now");
  });
});

const BOT_WITH_CHATS = {
  id: "bot_1",
  name: "Pirate",
  emoji: "🏴‍☠️",
  instructions: "Always answer in pirate speak.",
  providerId: "codex",
  model: "gpt-5.5",
  reasoningLevel: "medium" as const,
  projectId: null,
  status: "published" as const,
  createdAt: 0,
  updatedAt: 100,
};

const BOT_NO_CHATS = {
  id: "bot_2",
  name: "Builder",
  emoji: "🤖",
  instructions: "Fix the bot builder UX. ".repeat(20),
  providerId: "codex",
  model: "gpt-5.5",
  reasoningLevel: "medium" as const,
  projectId: null,
  status: "published" as const,
  createdAt: 0,
  updatedAt: 50,
};

const BOT_DRAFT = {
  id: "bot_3",
  name: "",
  emoji: "🧪",
  instructions: "",
  providerId: "",
  model: "",
  reasoningLevel: null,
  projectId: null,
  status: "draft" as const,
  createdAt: 0,
  updatedAt: 10,
};

const BOT_NAMED_DRAFT = {
  id: "bot_4",
  name: "Switcher",
  emoji: "🧪",
  instructions: "",
  providerId: "codex",
  model: "gpt-5.5",
  reasoningLevel: "medium" as const,
  projectId: null,
  status: "draft" as const,
  createdAt: 0,
  updatedAt: 10,
};

const RAIL_BOTS = [
  {
    ...BOT_WITH_CHATS,
    chats: [
      { threadId: "thr_new", title: "Ahoy there", status: "active", updatedAt: 200 },
    ],
    lastActivityAt: 200,
  },
  { ...BOT_NO_CHATS, chats: [], lastActivityAt: BOT_NO_CHATS.updatedAt },
  { ...BOT_DRAFT, chats: [], lastActivityAt: BOT_DRAFT.updatedAt },
];

const BOTS_BY_ID: Record<
  string,
  typeof BOT_WITH_CHATS | typeof BOT_NO_CHATS | typeof BOT_DRAFT
> = {
  bot_1: BOT_WITH_CHATS,
  bot_2: BOT_NO_CHATS,
  bot_3: BOT_DRAFT,
};

const REAL_SECRET = "whsec_0123456789abcdef";
const ROTATED_SECRET = "whsec_fedcba9876543210";

function hookState(botId: string, overrides: Partial<HookState> = {}): HookState {
  return {
    botId,
    enabled: false,
    rateLimitPerMin: 10,
    secretVersion: 1,
    urls: [`http://127.0.0.1:38990/hooks/${botId}`],
    primaryUrl: `http://127.0.0.1:38990/hooks/${botId}`,
    ignoredBaseUrls: [],
    listener: { state: "running", port: 38990, reason: null },
    ...overrides,
  };
}

const HOOK_RPC = {
  getHook: (input: unknown) => {
    const { botId } = input as { botId: string };
    return { hook: hookState(botId) };
  },
  saveHook: (input: unknown) => {
    const { botId, enabled, rateLimitPerMin } = input as {
      botId: string;
      enabled: boolean;
      rateLimitPerMin: number;
    };
    return { hook: hookState(botId, { enabled, rateLimitPerMin }) };
  },
  revealSecret: () => ({ secret: REAL_SECRET }),
  rotateSecret: (input: unknown) => {
    const { botId } = input as { botId: string };
    return { secret: ROTATED_SECRET, hook: hookState(botId, { secretVersion: 2 }) };
  },
};

const RPC = {
  listRail: () => ({ bots: RAIL_BOTS }),
  getBot: (input: unknown) => {
    const { botId } = input as { botId: string };
    return { bot: BOTS_BY_ID[botId] ?? null };
  },
  listChats: (input: unknown) => {
    const { botId } = input as { botId: string };
    if (botId === "bot_1") {
      return {
        chats: [
          {
            threadId: "thr_new",
            title: "Ahoy there",
            status: "active",
            updatedAt: 200,
            pinnedAt: null,
            archivedAt: null,
          },
        ],
        archivedChats: [],
      };
    }
    return { chats: [], archivedChats: [] };
  },
  unarchiveChat: () => ({ ok: true }),
  listOptions: () => ({
    providers: [{ id: "codex", displayName: "Codex", available: true }],
    projects: [{ id: "proj_work", name: "Work" }],
    personalProjectId: "proj_personal",
  }),
  listModels: () => ({
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "",
        isDefault: true,
        defaultReasoningEffort: "medium" as const,
        reasoningEfforts: ["medium" as const],
      },
    ],
  }),
  startChat: () => ({ threadId: "thr_from_home" }),
  createBot: () => ({ botId: "bot_new" }),
  saveBot: () => ({ ok: true }),
  publishBot: () => ({ ok: true }),
  deleteBot: () => ({ ok: true }),
  ...HOOK_RPC,
};

async function loadPanel() {
  const app = await loadPluginApp(() => import("./app"));
  const [panel] = app.navPanels;
  expect(panel).toBeDefined();
  return panel!;
}

describe("bots nav panel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers one panel at the bots path", async () => {
    const panel = await loadPanel();
    expect(panel.id).toBe("bots");
    expect(panel.path).toBe("bots");
    expect(panel.title).toBe("Bots");
  });

  it("renders the rail with bots, marking drafts with a DRAFT badge", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "" }, { rpc: RPC });
    await slot.findByText("Pirate");
    await slot.findByText("Builder");
    await slot.findByText("DRAFT");
    slot.lifecycle.unmount();
  });

  it("navigates to a bot when its rail row is clicked", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "" }, { rpc: RPC });
    (await slot.findByText("Builder")).click();
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "bots",
      options: { subPath: "bot_2" },
    });
    slot.lifecycle.unmount();
  });

  it("opens a bot and expands its threads from the row", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "" }, { rpc: RPC });
    fireEvent.click(await slot.findByText("Pirate"));
    expect(slot.getByRole("list", { name: "Pirate recent threads" })).toBeTruthy();
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "bots", options: { subPath: "bot_1" } });
    fireEvent.click(slot.getByLabelText("Collapse Pirate threads"));
    slot.lifecycle.unmount();
  });

  it("uses rail actions without toggling and confirms deletion", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "" }, { rpc: RPC });
    fireEvent.click(await slot.findByLabelText("Edit Pirate"));
    fireEvent.click(slot.getByLabelText("New thread for Pirate"));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "bots", options: { subPath: "bot_1/edit" } });
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "bots", options: { subPath: "bot_1/new" } });
    expect(slot.queryByRole("list", { name: "Pirate recent threads" })).toBeNull();
    fireEvent.contextMenu(slot.getByText("Pirate"));
    fireEvent.click(slot.getByRole("menuitem", { name: "Delete bot" }));
    expect(await slot.findByText("Delete Pirate?")).toBeTruthy();
    expect(slot.inspection.rpcCalls.some(call => call.method === "deleteBot")).toBe(false);
    fireEvent.click(slot.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual(expect.objectContaining({ method: "deleteBot", input: { botId: "bot_1" } })));
    slot.lifecycle.unmount();
  });

  it("creates a bot from the rail's new-bot button and routes to its editor", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "" }, { rpc: RPC });
    (await slot.findByLabelText("New bot")).click();

    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "bots",
        options: { subPath: "bot_new/edit" },
      }),
    );
    const createCall = slot.inspection.rpcCalls.find(
      (call) => call.method === "createBot",
    );
    expect(createCall?.input).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows the composer for a bot with chats instead of redirecting into the newest one", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1" }, { rpc: RPC });

    await slot.findByTestId("bb-new-thread-composer");
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("renders the chat list inside the bot page and navigates to a chat on click", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1" }, { rpc: RPC });

    await slot.findByText("Chats (1)");
    // "Ahoy there" also appears as the rail row's newest-chat preview, so
    // pick out the one that lives inside the bot page's chat list.
    const chatRowLabel = (await slot.findAllByText("Ahoy there")).find(
      (node) => node.closest("ul.divide-y") !== null,
    );
    expect(chatRowLabel).toBeDefined();
    chatRowLabel!.closest("button")!.click();

    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "bots",
      options: { subPath: "bot_1/thr_new" },
    });
    slot.lifecycle.unmount();
  });

  it("expands recent threads and opens the selected thread", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "" }, { rpc: RPC });
    const toggle = await slot.findByLabelText("Expand Pirate threads");
    fireEvent.click(toggle);
    const list = slot.getByRole("list", { name: "Pirate recent threads" });
    expect(list.textContent).toContain("Ahoy there");
    fireEvent.click(list.querySelector("button")!);
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "bots", options: { subPath: "bot_1/thr_new" } });
    fireEvent.click(slot.getByLabelText("Collapse Pirate threads"));
    expect(slot.queryByRole("list", { name: "Pirate recent threads" })).toBeNull();
    slot.lifecycle.unmount();
  });

  // Regression coverage for the shipped bug: the "⋯" trigger had both
  // onClick and onBlur, so moving focus from the trigger to any menu item
  // fired the trigger's blur (closing and unmounting the menu) before the
  // item's own click could land. Every item was dead. This drives the same
  // focus transfer a real mousedown-then-click does — trigger.focus(), then
  // item.focus() (which fires the trigger's blur with relatedTarget set to
  // the item), then item.click() — so it fails under the old handler and
  // passes only because the container-level blur now checks relatedTarget.
  it("fires New chat and Edit bot from the ⋯ menu despite the trigger losing focus to the item", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_2" }, { rpc: RPC });

    const menuButton = await slot.findByLabelText("More actions");
    menuButton.focus();
    menuButton.click();
    const newChatItem = await slot.findByText("New chat");
    fireEvent.focusOut(menuButton, { relatedTarget: newChatItem });
    expect(newChatItem.isConnected).toBe(true);
    newChatItem.click();

    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "bots",
      options: { subPath: "bot_2/new" },
    });

    const reopened = await slot.findByLabelText("More actions");
    reopened.focus();
    reopened.click();
    const editBotItem = await slot.findByText("Edit bot");
    fireEvent.focusOut(reopened, { relatedTarget: editBotItem });
    expect(editBotItem.isConnected).toBe(true);
    editBotItem.click();

    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "bots",
      options: { subPath: "bot_2/edit" },
    });
    slot.lifecycle.unmount();
  });

  it("opens the ⋯ menu, confirms Delete bot, and calls deleteBot", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_2" }, { rpc: RPC });

    const menuButton = await slot.findByLabelText("More actions");
    menuButton.focus();
    menuButton.click();
    const deleteItem = await slot.findByText("Delete bot");

    // The bug this pins: focus leaves the trigger for the menu item on
    // mousedown, and the old handler closed the menu right then — unmounting
    // the item before its click could land. jsdom's .focus() alone doesn't
    // reproduce that, so dispatch the focusout React actually listens for and
    // assert the item SURVIVES it before clicking.
    fireEvent.focusOut(menuButton, { relatedTarget: deleteItem });
    expect(deleteItem.isConnected).toBe(true);
    deleteItem.click();

    await slot.findByText("Delete Builder?");
    (await slot.findByRole("button", { name: "Delete" })).click();

    await waitFor(() => {
      const deleteCall = slot.inspection.rpcCalls.find(
        (call) => call.method === "deleteBot",
      );
      expect(deleteCall?.input).toEqual({ botId: "bot_2" });
    });
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "bots",
        options: { subPath: "", replace: true },
      }),
    );
    slot.lifecycle.unmount();
  });

  it("clamps instructions with a working Show more / Show less toggle", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_2" }, { rpc: RPC });

    const showMore = await slot.findByRole("button", { name: "Show more" });
    showMore.click();
    await slot.findByRole("button", { name: "Show less" });
    slot.lifecycle.unmount();
  });

  it("renders the header subtitle only when the bot has provider, model, or reasoning to show", async () => {
    const panel = await loadPanel();
    const configured = renderSlot(panel, { subPath: "bot_2" }, { rpc: RPC });
    const configuredHeader = (
      await configured.findByLabelText("Edit bot settings")
    ).parentElement!;
    expect(configuredHeader.textContent).toContain("codex · gpt-5.5 · medium");
    configured.lifecycle.unmount();

    // bot_3 is a draft with an empty providerId, an empty model, and a null
    // reasoningLevel, so the joined subtitle must collapse away entirely
    // rather than rendering the separators around missing parts.
    const draft = renderSlot(panel, { subPath: "bot_3" }, { rpc: RPC });
    const draftHeader = (
      await draft.findByLabelText("Edit bot settings")
    ).parentElement!;
    expect(draftHeader.textContent).not.toContain("·");
    draft.lifecycle.unmount();
  });

  it("exposes the ⋯ menu as an ARIA menu, with aria-expanded tracking open state", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_2" }, { rpc: RPC });

    const menuButton = await slot.findByLabelText("More actions");
    expect(menuButton.getAttribute("aria-haspopup")).toBe("menu");
    expect(menuButton.getAttribute("aria-expanded")).toBe("false");
    expect(slot.queryByRole("menu")).toBeNull();

    menuButton.click();

    await slot.findByRole("menu");
    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
    expect(
      slot.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["New chat", "Edit bot", "Delete bot"]);

    slot.lifecycle.unmount();
  });

  it("confirms before deleting a draft from the editor", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_3/edit" }, { rpc: RPC });

    (await slot.findByText("Delete draft")).click();
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "deleteBot"),
    ).toBe(false);

    await slot.findByText("Delete Untitled bot?");
    (await slot.findByRole("button", { name: "Cancel" })).click();
    await waitFor(() =>
      expect(slot.queryByText("Delete Untitled bot?")).toBeNull(),
    );
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "deleteBot"),
    ).toBe(false);

    (await slot.findByText("Delete draft")).click();
    await slot.findByText("Delete Untitled bot?");
    (await slot.findByRole("button", { name: "Delete" })).click();

    await waitFor(() => {
      const deleteCall = slot.inspection.rpcCalls.find(
        (call) => call.method === "deleteBot",
      );
      expect(deleteCall?.input).toEqual({ botId: "bot_3" });
    });
    slot.lifecycle.unmount();
  });

  it("clears the model and keeps Publish disabled when the picked provider has no models", async () => {
    // Radix's Select needs these; jsdom ships neither.
    Element.prototype.scrollIntoView = () => {};
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.releasePointerCapture = () => {};

    const panel = await loadPanel();
    const slot = renderSlot(
      panel,
      { subPath: "bot_4/edit" },
      {
        rpc: {
          ...RPC,
          getBot: () => ({ bot: BOT_NAMED_DRAFT }),
          listOptions: () => ({
            providers: [
              { id: "codex", displayName: "Codex", available: true },
              { id: "vacant", displayName: "Vacant", available: true },
            ],
            projects: [],
            personalProjectId: null,
          }),
          // Settled-and-empty, not pending: the editor must tell "this
          // provider offers nothing" apart from "still loading".
          listModels: (input: unknown) => {
            const { providerId } = input as { providerId: string };
            if (providerId === "vacant") return { models: [] };
            return RPC.listModels();
          },
        },
      },
    );

    const providerTrigger = await slot.findByLabelText("Provider");
    providerTrigger.focus();
    fireEvent.keyDown(providerTrigger, { key: "ArrowDown" });
    fireEvent.click(await slot.findByText("Vacant"));

    await waitFor(() =>
      expect(slot.getByLabelText("Model").textContent).toBe("Select a model"),
    );
    expect(
      slot.getByText("Publish bot").closest("button")!.disabled,
    ).toBe(true);

    slot.lifecycle.unmount();
  });

  it("shows a setup callout instead of a composer for a draft bot", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_3" }, { rpc: RPC });

    await slot.findByText("Finish setting up this bot");
    await slot.findByText("Set up →");
    expect(slot.queryByTestId("bb-new-thread-composer")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("seeds the host new-thread composer and starts a chat from BotHome", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_2" }, { rpc: RPC });

    const composer = await slot.findByTestId("bb-new-thread-composer");
    expect(composer.getAttribute("data-default-provider-id")).toBe("codex");
    expect(composer.getAttribute("data-default-model")).toBe("gpt-5.5");
    expect(composer.getAttribute("data-default-reasoning-level")).toBe(
      "medium",
    );

    (await slot.findByTestId("bb-new-thread-composer-submit")).click();

    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "bots",
        options: { subPath: "bot_2/thr_from_home" },
      }),
    );
    const startChatCall = slot.inspection.rpcCalls.find(
      (call) => call.method === "startChat",
    );
    expect(startChatCall?.input).toMatchObject({
      botId: "bot_2",
      request: { providerId: "codex", model: "gpt-5.5" },
    });
    slot.lifecycle.unmount();
  });

  it("selects an extra shape from the compact popup", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1/edit" }, { rpc: RPC });
    fireEvent.click(await slot.findByLabelText("Change icon"));
    fireEvent.click(await slot.findByRole("button", { name: "Blob" }));
    fireEvent.click(slot.getByRole("button", { name: "More shapes" }));
    fireEvent.click(slot.getByRole("button", { name: "triangle" }));
    expect(slot.queryByRole("group", { name: "More shapes" })).toBeNull();
    expect(slot.getByRole("button", { name: "triangle" }).getAttribute("aria-pressed")).toBe("true");
    expect(slot.getByRole("button", { name: "More shapes" }).getAttribute("aria-expanded")).toBe("false");
    slot.lifecycle.unmount();
  });

  it("lists the punctuation shapes and saves a selected one", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1/edit" }, { rpc: RPC });
    fireEvent.click(await slot.findByLabelText("Change icon"));
    fireEvent.click(await slot.findByRole("button", { name: "Blob" }));
    fireEvent.click(slot.getByRole("button", { name: "More shapes" }));
    const popup = within(slot.getByRole("group", { name: "More shapes" }));
    for (const shape of ["question", "exclaim", "plus", "hash"]) expect(popup.getByRole("button", { name: shape })).toBeTruthy();
    vi.useFakeTimers();
    try {
      fireEvent.click(popup.getByRole("button", { name: "hash" }));
      await vi.advanceTimersByTimeAsync(600);
      expect(slot.inspection.rpcCalls.find(call => call.method === "saveBot")?.input).toMatchObject({ patch: { avatar: { version: 1, type: "blob", shape: "hash" } } });
    } finally { vi.useRealTimers(); }
    slot.lifecycle.unmount();
  });

  it("selects a blob and saves a custom color", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1/edit" }, { rpc: RPC });
    fireEvent.click(await slot.findByLabelText("Change icon"));
    fireEvent.click(await slot.findByRole("button", { name: "Blob" }));
    vi.useFakeTimers();
    try {
      fireEvent.click(slot.getByRole("button", { name: "flower" }));
      fireEvent.change(slot.getByLabelText("Hex color"), { target: { value: "#123abc" } });
      await vi.advanceTimersByTimeAsync(600);
      expect(slot.inspection.rpcCalls.find(call => call.method === "saveBot")?.input).toMatchObject({ patch: { avatar: { version: 1, type: "blob", shape: "flower", color: "#123abc" } } });
    } finally { vi.useRealTimers(); }
    slot.lifecycle.unmount();
  });

  it("opens the emoji picker from the avatar and swaps the icon", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1/edit" }, { rpc: RPC });

    // bot_1's seeded emoji is "🏴‍☠️"; pick a different curated emoji from the
    // grid. "🦉" isn't used by any bot in RAIL_BOTS, so it can't collide with
    // an avatar rendered in the rail alongside the editor.
    const trigger = await slot.findByLabelText("Change icon");
    expect(slot.queryByText("Choose an avatar")).toBeNull();

    fireEvent.click(trigger);
    await slot.findByText("Choose an avatar");

    const target = slot.getByRole("button", { name: "🦉" });
    fireEvent.click(target);

    // Picking closes the dialog...
    expect(slot.queryByText("Choose an avatar")).toBeNull();
    // ...and the avatar now shows the picked emoji.
    expect(slot.getByText("🦉").isConnected).toBe(true);

    slot.lifecycle.unmount();
  });

  it("autosaves a picked emoji as an emoji patch after the debounce", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1/edit" }, { rpc: RPC });

    const trigger = await slot.findByLabelText("Change icon");
    fireEvent.click(trigger);
    await slot.findByText("Choose an avatar");

    // Install fake timers right before the state change that arms the
    // debounce, so the effect's setTimeout(..., AUTOSAVE_DELAY_MS) call is
    // captured by the fake clock instead of a real one.
    vi.useFakeTimers();
    try {
      const target = slot.getByRole("button", { name: "🦉" });
      fireEvent.click(target);

      await vi.advanceTimersByTimeAsync(600);

      const saveCall = slot.inspection.rpcCalls.find(
        (call) => call.method === "saveBot",
      );
      expect(saveCall?.input).toMatchObject({
        botId: "bot_1",
        patch: { emoji: "🦉" },
      });
    } finally {
      vi.useRealTimers();
    }

    slot.lifecycle.unmount();
  });

  it("auto-applies a single emoji typed into the custom field without clicking Use, and autosaves it as an emoji patch", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1/edit" }, { rpc: RPC });

    const trigger = await slot.findByLabelText("Change icon");
    fireEvent.click(trigger);
    await slot.findByText("Choose an avatar");

    vi.useFakeTimers();
    try {
      const customInput = slot.getByLabelText("Any other emoji");
      fireEvent.change(customInput, { target: { value: "🦉" } });

      // Auto-applied immediately — no "Use" click — and the dialog closes.
      expect(slot.queryByText("Choose an avatar")).toBeNull();
      expect(slot.getByText("🦉").isConnected).toBe(true);

      await vi.advanceTimersByTimeAsync(600);

      const saveCall = slot.inspection.rpcCalls.find(
        (call) => call.method === "saveBot",
      );
      expect(saveCall?.input).toMatchObject({
        botId: "bot_1",
        patch: { emoji: "🦉" },
      });
    } finally {
      vi.useRealTimers();
    }

    slot.lifecycle.unmount();
  });

  it("still has a working Shuffle icon button that lands on a curated emoji", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1/edit" }, { rpc: RPC });

    await slot.findByLabelText("Change icon");
    const shuffle = await slot.findByText("Shuffle icon");
    fireEvent.click(shuffle);

    const avatar = slot.getByLabelText("Change icon").querySelector("span[aria-hidden]");
    expect(avatar).not.toBeNull();
    expect(EMOJIS).toContain(avatar!.textContent);

    slot.lifecycle.unmount();
  });

  // -- Chat row menu (pin/rename/archive/delete) and the Archived section --
  //
  // Pin/rename/archive/delete all go through the host's
  // experimental_useSidebarThreadActions() hook, which the test harness
  // stubs and records to slot.inspection.sidebarActionCalls — no vi.mock
  // needed, this is the same seam renderSlot always provides.

  const CHAT_ROW_RPC = {
    ...RPC,
    listChats: (input: unknown) => {
      const { botId } = input as { botId: string };
      if (botId !== "bot_1") return { chats: [], archivedChats: [] };
      return {
        chats: [
          {
            threadId: "thr_new",
            title: "Ahoy there",
            status: "active",
            updatedAt: 200,
            pinnedAt: null,
            archivedAt: null,
          },
        ],
        archivedChats: [
          {
            threadId: "thr_old",
            title: "Buried treasure",
            status: "archived",
            updatedAt: 50,
            pinnedAt: null,
            archivedAt: 60,
          },
        ],
      };
    },
  };

  it("fires Pin from a chat row's ⋯ menu despite the trigger losing focus to the item", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1" }, { rpc: CHAT_ROW_RPC });

    await slot.findByText("Chats (1)");
    // Two "More actions" triggers exist on this page (the header's and the
    // chat row's); the row's is the last one rendered.
    const menuButtons = await slot.findAllByLabelText("More actions");
    const menuButton = menuButtons[menuButtons.length - 1]!;
    menuButton.focus();
    menuButton.click();
    const pinItem = await slot.findByText("Pin");

    // Same regression as the bot-header menu: the click must survive the
    // trigger's blur firing first.
    fireEvent.focusOut(menuButton, { relatedTarget: pinItem });
    expect(pinItem.isConnected).toBe(true);
    pinItem.click();

    await waitFor(() => {
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "setPinned",
        threadId: "thr_new",
        pinned: true,
      });
    });
    slot.lifecycle.unmount();
  });

  it("renames a chat inline: Enter commits the trimmed title, Escape cancels, and an unchanged/empty value fires nothing", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1" }, { rpc: CHAT_ROW_RPC });

    await slot.findByText("Chats (1)");
    const menuButtons = await slot.findAllByLabelText("More actions");
    const menuButton = menuButtons[menuButtons.length - 1]!;
    menuButton.focus();
    menuButton.click();
    const renameItem = await slot.findByText("Rename");
    fireEvent.focusOut(menuButton, { relatedTarget: renameItem });
    renameItem.click();

    const input = await slot.findByLabelText("Chat title");

    // Escape cancels — no RPC.
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(
      slot.inspection.sidebarActionCalls.some((call) => call.method === "rename"),
    ).toBe(false);
    await slot.findByText("Chats (1)");

    // Reopen, clear the title, Enter — empty is a no-op cancel, not a rename.
    const reopened = (await slot.findAllByLabelText("More actions")).at(-1)!;
    reopened.focus();
    reopened.click();
    const renameAgain = await slot.findByText("Rename");
    fireEvent.focusOut(reopened, { relatedTarget: renameAgain });
    renameAgain.click();
    const input2 = await slot.findByLabelText("Chat title");
    fireEvent.change(input2, { target: { value: "   " } });
    fireEvent.keyDown(input2, { key: "Enter" });
    expect(
      slot.inspection.sidebarActionCalls.some((call) => call.method === "rename"),
    ).toBe(false);

    // Reopen, type an actual new title, Enter commits it, trimmed.
    const reopened2 = (await slot.findAllByLabelText("More actions")).at(-1)!;
    reopened2.focus();
    reopened2.click();
    const renameThird = await slot.findByText("Rename");
    fireEvent.focusOut(reopened2, { relatedTarget: renameThird });
    renameThird.click();
    const input3 = await slot.findByLabelText("Chat title");
    fireEvent.change(input3, { target: { value: "  Treasure map  " } });
    fireEvent.keyDown(input3, { key: "Enter" });

    await waitFor(() => {
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "rename",
        threadId: "thr_new",
        title: "Treasure map",
      });
    });
    slot.lifecycle.unmount();
  });

  it("never nests the rename input inside a <button> and hides the navigate button entirely while editing", async () => {
    // Regression test for the disabled-ancestor-makes-descendants-inert bug:
    // an earlier ChatRow put the rename <input> inside a
    // disabled={isEditing} navigate <button>. jsdom doesn't enforce either
    // the invalid-HTML nesting or the real-browser inertness that causes,
    // so this is the assertion that would actually have caught it.
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1" }, { rpc: CHAT_ROW_RPC });

    await slot.findByText("Chats (1)");
    const menuButton = (await slot.findAllByLabelText("More actions")).at(-1)!;
    menuButton.focus();
    menuButton.click();
    const renameItem = await slot.findByText("Rename");
    fireEvent.focusOut(menuButton, { relatedTarget: renameItem });
    renameItem.click();

    const input = await slot.findByLabelText("Chat title");
    expect(input.closest("button")).toBeNull();

    // The navigate button itself is absent from the editing row — not
    // merely disabled. Its sibling group's row container is the input's
    // parent, and it has no <button> wrapping the title text anymore.
    expect(input.parentElement?.querySelector("button")).toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    slot.lifecycle.unmount();
  });

  it("calls archive with the chat's threadId from the ⋯ menu", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1" }, { rpc: CHAT_ROW_RPC });

    await slot.findByText("Chats (1)");
    const menuButton = (await slot.findAllByLabelText("More actions")).at(-1)!;
    menuButton.focus();
    menuButton.click();
    const archiveItem = await slot.findByText("Archive");
    fireEvent.focusOut(menuButton, { relatedTarget: archiveItem });
    expect(archiveItem.isConnected).toBe(true);
    archiveItem.click();

    await waitFor(() => {
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "archive",
        threadId: "thr_new",
      });
    });
    slot.lifecycle.unmount();
  });

  it("calls requestDelete (BB's own confirmation) rather than opening a local dialog", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1" }, { rpc: CHAT_ROW_RPC });

    await slot.findByText("Chats (1)");
    const menuButton = (await slot.findAllByLabelText("More actions")).at(-1)!;
    menuButton.focus();
    menuButton.click();
    const deleteItem = await slot.findByText("Delete");
    fireEvent.focusOut(menuButton, { relatedTarget: deleteItem });
    expect(deleteItem.isConnected).toBe(true);
    deleteItem.click();

    await waitFor(() => {
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "requestDelete",
        threadId: "thr_new",
      });
    });
    // No local confirmation dialog ever appears for a chat-row delete.
    expect(slot.queryByText("Delete Ahoy there?")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("hides the Archived section when there are no archived chats", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1" }, { rpc: RPC });

    await slot.findByText("Chats (1)");
    expect(slot.queryByText(/^Archived/)).toBeNull();
    slot.lifecycle.unmount();
  });

  it("renders the Archived section collapsed by default and shows its rows (with Unarchive/Delete only) once expanded", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1" }, { rpc: CHAT_ROW_RPC });

    await slot.findByText("Archived (1)");
    expect(slot.queryByText("Buried treasure")).toBeNull();

    fireEvent.click(slot.getByText("Archived (1)"));
    await slot.findByText("Buried treasure");

    const menuButtons = await slot.findAllByLabelText("More actions");
    const archivedMenuButton = menuButtons[menuButtons.length - 1]!;
    archivedMenuButton.focus();
    archivedMenuButton.click();

    expect(slot.queryByText("Pin")).toBeNull();
    expect(slot.queryByText("Rename")).toBeNull();
    await slot.findByText("Unarchive");
    await slot.findByText("Delete");

    slot.lifecycle.unmount();
  });

  it("calls the unarchiveChat RPC from an archived row's menu", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1" }, { rpc: CHAT_ROW_RPC });

    await slot.findByText("Archived (1)");
    fireEvent.click(slot.getByText("Archived (1)"));
    await slot.findByText("Buried treasure");

    const menuButton = (await slot.findAllByLabelText("More actions")).at(-1)!;
    menuButton.focus();
    menuButton.click();
    const unarchiveItem = await slot.findByText("Unarchive");
    fireEvent.focusOut(menuButton, { relatedTarget: unarchiveItem });
    expect(unarchiveItem.isConnected).toBe(true);
    unarchiveItem.click();

    await waitFor(() => {
      const call = slot.inspection.rpcCalls.find(
        (call) => call.method === "unarchiveChat",
      );
      expect(call?.input).toEqual({ threadId: "thr_old" });
    });
    slot.lifecycle.unmount();
  });
});

describe("bot editor webhook section", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function stubClipboard() {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    return writeText;
  }

  it("saves the Enabled toggle at once", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1/edit" }, { rpc: RPC });

    const toggle = (await slot.findByLabelText("Enabled")) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);

    await waitFor(() => {
      const call = slot.inspection.rpcCalls.find((call) => call.method === "saveHook");
      expect(call?.input).toEqual({ botId: "bot_1", enabled: true, rateLimitPerMin: 10 });
    });
    expect(toggle.checked).toBe(true);
    slot.lifecycle.unmount();
  });

  it("autosaves the rate limit after the debounce, kept inside the contract bounds", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1/edit" }, { rpc: RPC });

    const rate = await slot.findByLabelText("Rate limit");
    vi.useFakeTimers();
    try {
      fireEvent.change(rate, { target: { value: "9999" } });
      expect(
        slot.inspection.rpcCalls.some((call) => call.method === "saveHook"),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(600);
      const call = slot.inspection.rpcCalls.find((call) => call.method === "saveHook");
      expect(call?.input).toEqual({
        botId: "bot_1",
        enabled: false,
        rateLimitPerMin: HOOK_RATE_LIMIT_MAX,
      });
    } finally {
      vi.useRealTimers();
    }
    slot.lifecycle.unmount();
  });

  it("lists one URL per base URL, each with its own Copy, and no local-only notice", async () => {
    const writeText = stubClipboard();
    const urls = ["https://hooks.you.com/hooks/bot_1", "http://127.0.0.1:38990/hooks/bot_1"];
    const panel = await loadPanel();
    const slot = renderSlot(
      panel,
      { subPath: "bot_1/edit" },
      {
        rpc: {
          ...RPC,
          getHook: () => ({ hook: hookState("bot_1", { urls, primaryUrl: urls[0]! }) }),
        },
      },
    );
    for (const url of urls) {
      expect(((await slot.findByLabelText(`Webhook URL ${url}`)) as HTMLInputElement).value).toBe(url);
    }
    expect(slot.queryByText(/Local only/)).toBeNull();
    expect(slot.queryByRole("button", { name: "Copy local" })).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: `Copy ${urls[1]}` }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(urls[1]));
    fireEvent.click(slot.getByRole("button", { name: `Copy ${urls[0]}` }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(urls[0]));
    slot.lifecycle.unmount();
  });

  describe("listener status line", () => {
    async function showHook(botId: string, hook: Partial<HookState>) {
      const panel = await loadPanel();
      return renderSlot(
        panel,
        { subPath: `${botId}/edit` },
        { rpc: { ...RPC, getHook: () => ({ hook: hookState(botId, { enabled: true, ...hook }) }) } },
      );
    }

    it("running: Listening on 127.0.0.1:<port> — point your tunnel here", async () => {
      const slot = await showHook("bot_1", {
        listener: { state: "running", port: 38995, reason: null },
      });
      await slot.findByText("Listening on 127.0.0.1:38995 — point your tunnel here");
      slot.lifecycle.unmount();
    });

    it("no base URL: Stopped — add a base URL in plugin settings", async () => {
      const slot = await showHook("bot_1", {
        urls: [],
        primaryUrl: null,
        listener: { state: "stopped", port: 38990, reason: null },
      });
      await slot.findByText("Stopped — add a base URL in plugin settings");
      expect(slot.queryByText(/Listening on/)).toBeNull();
      expect(slot.queryByText("URLs")).toBeNull();
      slot.lifecycle.unmount();
    });

    it("draft bot: Publish this bot to receive webhooks", async () => {
      const slot = await showHook("bot_3", {});
      await slot.findByText("Publish this bot to receive webhooks");
      expect(slot.queryByText(/Listening on/)).toBeNull();
      slot.lifecycle.unmount();
    });

    it("port in use: Port <port> is in use — choose another port in plugin settings", async () => {
      const slot = await showHook("bot_1", {
        listener: { state: "error", port: 38990, reason: "port-in-use" },
      });
      await slot.findByText("Port 38990 is in use — choose another port in plugin settings");
      slot.lifecycle.unmount();
    });

    it("invalid base URL entry: \"<entry>\" ignored — use a full URL that starts with https://", async () => {
      const slot = await showHook("bot_1", { ignoredBaseUrls: ["hooks.you.com"] });
      await slot.findByText('"hooks.you.com" ignored — use a full URL that starts with https://');
      // The entry that was ignored sits next to the state of the listener.
      await slot.findByText(/Listening on 127\.0\.0\.1:38990/);
      slot.lifecycle.unmount();
    });

    it("an invalid port setting and any other listener error are shown", async () => {
      const invalid = await showHook("bot_1", {
        listener: { state: "error", port: 38990, reason: "port-invalid" },
      });
      await invalid.findByText(/The listener port must be a whole number from 1024 to 65535/);
      invalid.lifecycle.unmount();

      const other = await showHook("bot_1", {
        listener: { state: "error", port: 38990, reason: "EACCES" },
      });
      await other.findByText("The listener could not start — EACCES");
      other.lifecycle.unmount();
    });

    it("asks again while the listener is still starting, then shows the result", async () => {
      let calls = 0;
      const panel = await loadPanel();
      const slot = renderSlot(
        panel,
        { subPath: "bot_1/edit" },
        {
          rpc: {
            ...RPC,
            getHook: () => {
              calls += 1;
              return {
                hook: hookState("bot_1", {
                  enabled: true,
                  listener:
                    calls < 2
                      ? { state: "stopped", port: 38990, reason: "starting" }
                      : { state: "running", port: 38990, reason: null },
                }),
              };
            },
          },
        },
      );
      await slot.findByText("Starting the listener…");
      await slot.findByText("Listening on 127.0.0.1:38990 — point your tunnel here", undefined, {
        timeout: 4000,
      });
      expect(calls).toBe(2);
      slot.lifecycle.unmount();
    });

    it("shows no status line while the webhook is off", async () => {
      const panel = await loadPanel();
      const slot = renderSlot(panel, { subPath: "bot_1/edit" }, { rpc: RPC });
      await slot.findByLabelText("Enabled");
      expect(slot.queryByText(/Listening on/)).toBeNull();
      expect(slot.queryByRole("status")).toBeNull();
      slot.lifecycle.unmount();
    });
  });

  it("reveals the secret on the first click and hides it on the second", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1/edit" }, { rpc: RPC });

    const secret = (await slot.findByLabelText("Secret")) as HTMLInputElement;
    expect(secret.value).toBe("whsec_••••••••");
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "revealSecret"),
    ).toBe(false);

    fireEvent.click(slot.getByRole("button", { name: "Reveal" }));
    await waitFor(() => expect(secret.value).toBe(REAL_SECRET));
    expect(
      slot.inspection.rpcCalls.find((call) => call.method === "revealSecret")?.input,
    ).toEqual({ botId: "bot_1" });

    fireEvent.click(slot.getByRole("button", { name: "Hide" }));
    expect(secret.value).toBe("whsec_••••••••");
    slot.lifecycle.unmount();
  });

  it("copies the secret without showing it", async () => {
    const writeText = stubClipboard();
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1/edit" }, { rpc: RPC });

    fireEvent.click(await slot.findByRole("button", { name: "Copy secret" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(REAL_SECRET));
    expect((slot.getByLabelText("Secret") as HTMLInputElement).value).toBe(
      "whsec_••••••••",
    );
    slot.lifecycle.unmount();
  });

  it("asks before Rotate, then shows the new secret", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1/edit" }, { rpc: RPC });

    fireEvent.click(await slot.findByRole("button", { name: "Rotate" }));
    await slot.findByText("The old secret stops working at once.");
    fireEvent.click(await slot.findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(slot.queryByText("The old secret stops working at once.")).toBeNull(),
    );
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "rotateSecret"),
    ).toBe(false);

    fireEvent.click(slot.getByRole("button", { name: "Rotate" }));
    fireEvent.click(await slot.findByRole("button", { name: "Rotate secret" }));
    await waitFor(() =>
      expect((slot.getByLabelText("Secret") as HTMLInputElement).value).toBe(
        ROTATED_SECRET,
      ),
    );
    expect(
      slot.inspection.rpcCalls.find((call) => call.method === "rotateSecret")?.input,
    ).toEqual({ botId: "bot_1" });
    slot.lifecycle.unmount();
  });

  it("shows the publish banner for a draft bot and keeps the toggle editable", async () => {
    const panel = await loadPanel();
    const draft = renderSlot(panel, { subPath: "bot_3/edit" }, { rpc: RPC });
    await draft.findByText("Publish this bot to activate its webhook.");
    const toggle = draft.getByLabelText("Enabled") as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        draft.inspection.rpcCalls.find((call) => call.method === "saveHook")?.input,
      ).toMatchObject({ botId: "bot_3", enabled: true }),
    );
    draft.lifecycle.unmount();

    const published = renderSlot(panel, { subPath: "bot_1/edit" }, { rpc: RPC });
    await published.findByLabelText("Enabled");
    expect(published.queryByText("Publish this bot to activate its webhook.")).toBeNull();
    published.lifecycle.unmount();
  });

  it("copies a curl example that never contains the real secret", async () => {
    const writeText = stubClipboard();
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "bot_1/edit" }, { rpc: RPC });

    // Load the real secret into the form first, so a leak would show up.
    fireEvent.click(await slot.findByRole("button", { name: "Reveal" }));
    await waitFor(() =>
      expect((slot.getByLabelText("Secret") as HTMLInputElement).value).toBe(REAL_SECRET),
    );

    fireEvent.click(slot.getByRole("button", { name: "Copy curl example" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = writeText.mock.calls.at(-1)![0];
    expect(text).toContain("URL='http://127.0.0.1:38990/hooks/bot_1'");
    expect(text).not.toContain("/api/v1/");
    expect(text).toContain("SECRET='whsec_REPLACE_ME'");
    expect(text).toContain('-H "X-Hook-Signature: sha256=$SIG"');
    expect(text).not.toContain(REAL_SECRET);
    slot.lifecycle.unmount();
  });

  it("builds the curl example from the primary URL, and disables it without one", async () => {
    const writeText = stubClipboard();
    const panel = await loadPanel();
    const urls = ["https://hooks.you.com/hooks/bot_1", "http://127.0.0.1:38990/hooks/bot_1"];
    const withUrls = renderSlot(
      panel,
      { subPath: "bot_1/edit" },
      {
        rpc: {
          ...RPC,
          getHook: () => ({ hook: hookState("bot_1", { urls, primaryUrl: urls[0]! }) }),
        },
      },
    );
    fireEvent.click(await withUrls.findByRole("button", { name: "Copy curl example" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls.at(-1)![0]).toContain("URL='https://hooks.you.com/hooks/bot_1'");
    withUrls.lifecycle.unmount();

    const none = renderSlot(
      panel,
      { subPath: "bot_1/edit" },
      {
        rpc: {
          ...RPC,
          getHook: () => ({ hook: hookState("bot_1", { urls: [], primaryUrl: null }) }),
        },
      },
    );
    const button = (await none.findByRole("button", { name: "Copy curl example" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    none.lifecycle.unmount();
  });
});
