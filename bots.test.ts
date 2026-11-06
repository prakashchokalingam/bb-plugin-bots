import { describe, expect, it } from "vitest";
import {
  displayName,
  draftBlockers,
  emojiPickerHint,
  EMOJI_GROUPS,
  EMOJIS,
  INSTRUCTION_LIMIT,
  isSingleEmoji,
  MAX_INSTRUCTIONS,
  normalizeEmoji,
  parseRoute,
  pickEmoji,
  previewInstructions,
  renderBotInstructions,
  routeToSubPath,
  rowToBot,
  sortChats,
  type Bot,
  type BotRow,
} from "./bots.js";

const bot: Bot = {
  id: "bot_1",
  name: "Pirate",
  emoji: "🏴‍☠️",
  instructions: "Always answer in pirate speak.",
  providerId: "codex",
  model: "gpt-5.5",
  reasoningLevel: "medium",
  projectId: null,
  status: "published",
  createdAt: 0,
  updatedAt: 0,
};

describe("parseRoute", () => {
  it("maps every subPath shape", () => {
    expect(parseRoute("")).toEqual({ view: "list" });
    expect(parseRoute("new")).toEqual({ view: "new" });
    expect(parseRoute("bot_1")).toEqual({ view: "bot", botId: "bot_1" });
    expect(parseRoute("bot_1/edit")).toEqual({ view: "edit", botId: "bot_1" });
    expect(parseRoute("bot_1/new")).toEqual({
      view: "newChat",
      botId: "bot_1",
    });
    expect(parseRoute("bot_1/thr_9")).toEqual({
      view: "chat",
      botId: "bot_1",
      threadId: "thr_9",
    });
  });

  it("tolerates stray slashes", () => {
    expect(parseRoute("/")).toEqual({ view: "list" });
    expect(parseRoute("/bot_1/")).toEqual({ view: "bot", botId: "bot_1" });
  });

  it("round-trips through routeToSubPath", () => {
    for (const subPath of [
      "",
      "new",
      "bot_1",
      "bot_1/edit",
      "bot_1/new",
      "bot_1/thr_9",
    ]) {
      expect(routeToSubPath(parseRoute(subPath))).toBe(subPath);
    }
  });
});

describe("draftBlockers", () => {
  it("returns [] when name, provider, and model are all present", () => {
    expect(draftBlockers(bot)).toEqual([]);
  });

  it("reports a missing name", () => {
    expect(draftBlockers({ ...bot, name: "  " })).toEqual(["a name"]);
  });

  it("reports a missing provider", () => {
    expect(draftBlockers({ ...bot, providerId: "" })).toEqual(["a provider"]);
  });

  it("reports a missing model", () => {
    expect(draftBlockers({ ...bot, model: "" })).toEqual(["a model"]);
  });

  it("reports every missing field, in name/provider/model order", () => {
    expect(
      draftBlockers({ ...bot, name: "", providerId: "", model: "" }),
    ).toEqual(["a name", "a provider", "a model"]);
  });
});

describe("displayName", () => {
  it("returns the trimmed name when set", () => {
    expect(displayName(bot)).toBe("Pirate");
  });

  it("falls back to a placeholder for a blank name", () => {
    expect(displayName({ ...bot, name: "" })).toBe("Untitled bot");
  });

  it("falls back to a placeholder for a whitespace-only name", () => {
    expect(displayName({ ...bot, name: "   " })).toBe("Untitled bot");
  });
});

describe("renderBotInstructions", () => {
  it("includes the name and the raw instructions", () => {
    const rendered = renderBotInstructions(bot);
    expect(rendered).toContain("Pirate");
    expect(rendered).toContain("Always answer in pirate speak.");
  });

  it("stays under BB's instruction limit at maximum length", () => {
    const rendered = renderBotInstructions({
      ...bot,
      name: "x".repeat(60),
      instructions: "y".repeat(MAX_INSTRUCTIONS),
    });
    expect(rendered.length).toBeLessThanOrEqual(INSTRUCTION_LIMIT);
  });
});

describe("previewInstructions", () => {
  it("collapses multi-line input to one line", () => {
    expect(previewInstructions("Always\nanswer\nin pirate speak.")).toBe(
      "Always answer in pirate speak.",
    );
  });

  it("trims leading and trailing whitespace", () => {
    expect(previewInstructions("  Always answer in pirate speak.  \n")).toBe(
      "Always answer in pirate speak.",
    );
  });

  it("returns the fallback for an empty string", () => {
    expect(previewInstructions("")).toBe("No instructions yet.");
  });

  it("returns the fallback for a whitespace-only string", () => {
    expect(previewInstructions("   \n\t  ")).toBe("No instructions yet.");
  });

  it("collapses a markdown heading followed by blank lines", () => {
    expect(previewInstructions("# Pirate\n\n\nAlways answer in pirate speak.")).toBe(
      "# Pirate Always answer in pirate speak.",
    );
  });

  it("passes ordinary single-line text through unchanged", () => {
    expect(previewInstructions("Always answer in pirate speak.")).toBe(
      "Always answer in pirate speak.",
    );
  });
});

describe("pickEmoji", () => {
  it("returns a member of the curated set", () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(EMOJIS).toContain(pickEmoji());
    }
  });
});

describe("EMOJI_GROUPS", () => {
  it("flattens to exactly EMOJIS, in the same order (anti-drift guard)", () => {
    expect(EMOJI_GROUPS.flatMap((group) => group.emojis)).toEqual(EMOJIS);
  });

  it("gives every group a non-empty label and at least one emoji", () => {
    for (const group of EMOJI_GROUPS) {
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.emojis.length).toBeGreaterThan(0);
    }
  });
});

describe("normalizeEmoji", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeEmoji("  🤖  ")).toBe("🤖");
  });

  it("returns null for an empty string", () => {
    expect(normalizeEmoji("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(normalizeEmoji("   \n\t  ")).toBeNull();
  });

  it("returns null for input longer than 16 characters", () => {
    expect(normalizeEmoji("x".repeat(17))).toBeNull();
  });

  it("accepts input exactly at the 16-character bound", () => {
    const input = "x".repeat(16);
    expect(normalizeEmoji(input)).toBe(input);
  });

  it("accepts a multi-codepoint emoji within the length bound", () => {
    const pirateFlag = "🏴‍☠️";
    expect(pirateFlag.length).toBeLessThanOrEqual(16);
    expect(normalizeEmoji(pirateFlag)).toBe(pirateFlag);
  });
});

describe("isSingleEmoji", () => {
  it("is true for a simple single emoji", () => {
    expect(isSingleEmoji("🤖")).toBe(true);
  });

  it("is true for a multi-codepoint flag sequence", () => {
    expect(isSingleEmoji("🏴‍☠️")).toBe(true);
  });

  it("is true for an emoji with a skin-tone modifier", () => {
    expect(isSingleEmoji("👍🏽")).toBe(true);
  });

  it("is true for a ZWJ-joined profession emoji", () => {
    expect(isSingleEmoji("👩‍💻")).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isSingleEmoji("  🤖  ")).toBe(true);
  });

  it("is false for a single non-emoji character, so typing a letter cannot become an icon", () => {
    expect(isSingleEmoji("a")).toBe(false);
    expect(isSingleEmoji("7")).toBe(false);
    expect(isSingleEmoji(".")).toBe(false);
  });

  it("is true for a keycap sequence", () => {
    expect(isSingleEmoji("1️⃣")).toBe(true);
  });

  it("is true for a regional-indicator flag", () => {
    expect(isSingleEmoji("🇺🇸")).toBe(true);
  });

  it("is false for two plain characters", () => {
    expect(isSingleEmoji("ab")).toBe(false);
  });

  it("is false for two separate emoji", () => {
    expect(isSingleEmoji("🤖🤖")).toBe(false);
  });

  it("is false for an empty string", () => {
    expect(isSingleEmoji("")).toBe(false);
  });

  it("is false for whitespace-only input", () => {
    expect(isSingleEmoji("  ")).toBe(false);
  });
});

describe("sortChats", () => {
  it("puts pinned chats ahead of unpinned ones regardless of updatedAt", () => {
    const chats = [
      { threadId: "a", pinnedAt: null, updatedAt: 100 },
      { threadId: "b", pinnedAt: 5, updatedAt: 1 },
    ];
    expect(sortChats(chats).map((chat) => chat.threadId)).toEqual(["b", "a"]);
  });

  it("orders multiple pinned chats by pinnedAt descending (most recently pinned first)", () => {
    const chats = [
      { threadId: "a", pinnedAt: 10, updatedAt: 1 },
      { threadId: "b", pinnedAt: 30, updatedAt: 1 },
      { threadId: "c", pinnedAt: 20, updatedAt: 1 },
    ];
    expect(sortChats(chats).map((chat) => chat.threadId)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("orders unpinned chats by updatedAt descending", () => {
    const chats = [
      { threadId: "a", pinnedAt: null, updatedAt: 5 },
      { threadId: "b", pinnedAt: null, updatedAt: 15 },
      { threadId: "c", pinnedAt: null, updatedAt: 10 },
    ];
    expect(sortChats(chats).map((chat) => chat.threadId)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("does not mutate the input array", () => {
    const chats = [
      { threadId: "a", pinnedAt: null, updatedAt: 1 },
      { threadId: "b", pinnedAt: null, updatedAt: 2 },
    ];
    const original = [...chats];
    sortChats(chats);
    expect(chats).toEqual(original);
  });
});

describe("emojiPickerHint", () => {
  it("prefers the touch hint even when the platform looks like a desktop", () => {
    expect(emojiPickerHint({ platform: "MacIntel", isTouch: true })).toBe(
      "Tap the emoji key on your keyboard",
    );
  });

  it("names the macOS shortcut for MacIntel", () => {
    expect(emojiPickerHint({ platform: "MacIntel", isTouch: false })).toBe(
      "Press ⌃⌘Space for your system emoji picker",
    );
  });

  it("names the macOS shortcut for iPhone", () => {
    expect(emojiPickerHint({ platform: "iPhone", isTouch: false })).toBe(
      "Press ⌃⌘Space for your system emoji picker",
    );
  });

  it("names the Windows shortcut for Win32", () => {
    expect(emojiPickerHint({ platform: "Win32", isTouch: false })).toBe(
      "Press Win + . for your system emoji picker",
    );
  });

  it("falls back to a generic hint for Linux", () => {
    expect(emojiPickerHint({ platform: "Linux x86_64", isTouch: false })).toBe(
      "Use your system emoji picker",
    );
  });
});

describe("rowToBot", () => {
  const row: BotRow = {
    id: "bot_1",
    name: "Pirate",
    emoji: "🏴‍☠️",
    instructions: "Always answer in pirate speak.",
    provider_id: "codex",
    model: "gpt-5.5",
    reasoning_level: "medium",
    project_id: null,
    status: "published",
    created_at: 0,
    updated_at: 0,
  };

  it("keeps a standard reasoning level", () => {
    expect(rowToBot(row).reasoningLevel).toBe("medium");
  });

  it("keeps a provider-specific reasoning level", () => {
    expect(rowToBot({ ...row, reasoning_level: "turbo" }).reasoningLevel).toBe("turbo");
  });

  it("reads an empty stored reasoning level as unset", () => {
    expect(rowToBot({ ...row, reasoning_level: "" }).reasoningLevel).toBeNull();
  });
});
