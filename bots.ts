// Pure bot logic — no BB handle, no I/O. Everything here is unit-testable
// without a running server.

/** BB truncates instruction contributions at 4096 characters. */
export const INSTRUCTION_LIMIT = 4096;

/**
 * Budget for the user's own instruction text, leaving room for the persona
 * wrapper renderBotInstructions puts around it.
 */
export const MAX_INSTRUCTIONS = 3500;

export const MAX_NAME = 60;

/**
 * The curated emoji set, grouped for the picker UI. Order within and across
 * groups matches the flat EMOJIS list below, which is derived from this so
 * the two can never drift apart.
 */
export const EMOJI_GROUPS = [
  {
    label: "Characters",
    emojis: ["🤖", "🧠", "🦉", "🐙", "🦊", "🐳", "🦖", "🐝", "🦜", "🐸"],
  },
  {
    label: "Explore",
    emojis: ["🚀", "🛰️", "🧭", "🔭", "⚗️", "🧪", "📐", "🧵", "🪄", "🎯"],
  },
  {
    label: "Craft",
    emojis: ["🎩", "🎨", "🎬", "🎲", "🧩", "📚", "🗺️", "🏴‍☠️", "⚓", "🔮"],
  },
  {
    label: "Flavor",
    emojis: ["🍜", "🍕", "☕", "🌶️", "🍄", "🌵", "🌊", "🔥", "❄️", "⚡"],
  },
] as const;

export const EMOJIS: readonly string[] = EMOJI_GROUPS.flatMap(
  (group) => group.emojis,
);

const TINTS = [
  "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
] as const;

/** BB reasoning levels are open strings; providers declare their own. */
export type ReasoningLevel = string;

export type BotStatus = "draft" | "published";

export const AVATAR_SHAPES = ["round", "flower", "star", "cloud", "heart", "shield", "hexagon", "sun", "triangle"] as const;
export const AVATAR_COLORS = ["#a78bfa", "#60a5fa", "#fb927c", "#4ade80", "#fbbf24", "#f472b6"] as const;
export type BlobAvatar = { version: 1; type: "blob"; shape: typeof AVATAR_SHAPES[number]; color: string };
export function randomAvatar(): BlobAvatar {
  return { version: 1, type: "blob", shape: AVATAR_SHAPES[Math.floor(Math.random() * AVATAR_SHAPES.length)]!, color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]! };
}
export function parseAvatar(value: string | null | undefined): BlobAvatar | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    if (v?.version === 1 && v.type === "blob" && AVATAR_SHAPES.includes(v.shape) && typeof v.color === "string" && /^#[0-9a-fA-F]{6}$/.test(v.color) && Object.keys(v).every(key => ["version", "type", "shape", "color"].includes(key))) return v;
  } catch { /* Fall back to the stored emoji. */ }
  return null;
}

export interface Bot {
  id: string;
  name: string;
  emoji: string;
  avatar?: BlobAvatar | null;
  instructions: string;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel | null;
  /** null = projectless chat in BB's personal project. */
  projectId: string | null;
  status: BotStatus;
  createdAt: number;
  updatedAt: number;
}

export function pickEmoji(): string {
  return EMOJIS[Math.floor(Math.random() * EMOJIS.length)]!;
}

/**
 * Trims and validates a user-entered emoji. The 16-character bound mirrors
 * the saveBot RPC schema (server.ts: `z.string().min(1).max(16)`) so the UI
 * can reject an out-of-range value locally instead of round-tripping to the
 * server just to have it bounce.
 */
export function normalizeEmoji(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 16) return null;
  return trimmed;
}

/**
 * True when the trimmed value is exactly one user-perceived character
 * (grapheme cluster) — e.g. a single emoji, however many code points it's
 * built from ("🏴‍☠️", "👍🏽", "👩‍💻" all count as one). Used to auto-apply an
 * emoji inserted via the OS picker without requiring an explicit "Use" click.
 */
export function isSingleEmoji(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  // Being one grapheme is not enough — "a" is one grapheme too, and auto-apply
  // would turn the first letter someone types into the bot's icon. Require the
  // cluster to actually be emoji: a pictographic character, a regional-indicator
  // pair (flags), or a combining enclosing keycap ("1️⃣", which is not itself
  // Extended_Pictographic).
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{20E3}/u.test(trimmed)) {
    return false;
  }
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const segments = [...segmenter.segment(trimmed)];
    return segments.length === 1;
  }
  // Fallback heuristic when Intl.Segmenter is unavailable: count Unicode
  // code points (not UTF-16 code units) as a rough grapheme-cluster count.
  // This over-counts sequences joined by ZWJ/variation selectors/skin-tone
  // modifiers, so it's a coarser approximation than Intl.Segmenter.
  return [...trimmed].length === 1;
}

/**
 * The human-readable hint naming how to open the OS emoji picker, given the
 * platform string and touch-capability the caller already read from
 * `navigator`. Pure — never reads globals itself, so it's trivial to test.
 */
export function emojiPickerHint(input: {
  platform: string;
  isTouch: boolean;
}): string {
  if (input.isTouch) return "Tap the emoji key on your keyboard";
  const platform = input.platform.toLowerCase();
  if (platform.includes("mac") || platform.includes("iphone") || platform.includes("ipad")) {
    return "Press ⌃⌘Space for your system emoji picker";
  }
  if (platform.includes("win")) {
    return "Press Win + . for your system emoji picker";
  }
  return "Use your system emoji picker";
}

/** Stable non-cryptographic hash, used only to pick a display tint. */
function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(result);
}

/** Deterministic avatar tint classes for a bot id. */
export function tintFor(botId: string): string {
  return TINTS[hash(botId) % TINTS.length]!;
}

export function newBotId(): string {
  // The "bot_" prefix keeps ids from colliding with the "new" route word.
  return `bot_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function clampInstructions(instructions: string): string {
  return instructions.trim().slice(0, MAX_INSTRUCTIONS);
}

/** Single-line preview of a bot's instructions for list cards. */
export function previewInstructions(instructions: string): string {
  const collapsed = instructions.replace(/\s+/g, " ").trim();
  return collapsed.length > 0 ? collapsed : "No instructions yet.";
}

/** The editor autosaves drafts with a blank name, so list cards need a fallback. */
export function displayName(bot: Bot): string {
  return bot.name.trim() || "Untitled bot";
}

/**
 * Human-readable reasons a draft can't be published yet; [] means it can.
 * Publish-time is where validation now lives — saveBot autosaves a
 * half-typed bot on every keystroke, so it can't require these fields.
 */
export function draftBlockers(bot: Bot): string[] {
  const blockers: string[] = [];
  if (bot.name.trim().length === 0) blockers.push("a name");
  if (bot.providerId.length === 0) blockers.push("a provider");
  if (bot.model.length === 0) blockers.push("a model");
  return blockers;
}

/**
 * The persona block BB injects into every turn of a bot's threads. Kept under
 * INSTRUCTION_LIMIT by construction: MAX_INSTRUCTIONS plus this wrapper.
 */
export function renderBotInstructions(bot: Bot): string {
  return [
    `# Custom bot: ${bot.name}`,
    "",
    `You are running as a custom bot named "${bot.name}" that the user built.`,
    "The instructions below are the user's standing configuration for this bot.",
    "Follow them in every response in this conversation, including later turns.",
    "They take precedence over your default response style. If they conflict",
    "with a specific request the user makes later, follow the later request.",
    "",
    "<bot-instructions>",
    bot.instructions,
    "</bot-instructions>",
  ].join("\n");
}

export type Route =
  | { view: "list" }
  | { view: "new" }
  | { view: "bot"; botId: string }
  | { view: "edit"; botId: string }
  | { view: "newChat"; botId: string }
  | { view: "chat"; botId: string; threadId: string };

/**
 * Maps a navPanel subPath onto a view. Unknown shapes fall back to the list.
 * A second segment of "new" is the fresh-chat route rather than a thread id —
 * real thread ids are `thr_*`, so there's no collision.
 */
export function parseRoute(subPath: string): Route {
  const segments = subPath.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return { view: "list" };
  const [first, second] = segments;
  if (first === "new") return { view: "new" };
  if (first === undefined) return { view: "list" };
  if (second === undefined) return { view: "bot", botId: first };
  if (second === "edit") return { view: "edit", botId: first };
  if (second === "new") return { view: "newChat", botId: first };
  return { view: "chat", botId: first, threadId: second };
}

export function routeToSubPath(route: Route): string {
  switch (route.view) {
    case "list":
      return "";
    case "new":
      return "new";
    case "bot":
      return route.botId;
    case "edit":
      return `${route.botId}/edit`;
    case "newChat":
      return `${route.botId}/new`;
    case "chat":
      return `${route.botId}/${route.threadId}`;
  }
}

/** A row as stored in SQLite (snake_case, integers for timestamps). */
export interface BotRow {
  id: string;
  name: string;
  emoji: string;
  avatar_json?: string | null;
  instructions: string;
  provider_id: string;
  model: string;
  reasoning_level: string | null;
  project_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

/** The subset of ChatSchema (server.ts) that sortChats needs to order a list. */
export interface ChatSortable {
  pinnedAt: number | null;
  updatedAt: number;
}

/**
 * Orders a bot's active chats for the list: pinned chats first (most
 * recently pinned on top), then everything else by most-recently-updated.
 * Exported as a pure helper — separate from listChats's I/O — so the
 * ordering rule is unit-testable without spinning up a fake plugin host.
 */
export function sortChats<T extends ChatSortable>(chats: readonly T[]): T[] {
  return [...chats].sort((a, b) => {
    const aPinned = a.pinnedAt !== null;
    const bPinned = b.pinnedAt !== null;
    if (aPinned && bPinned) return b.pinnedAt! - a.pinnedAt!;
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

export function rowToBot(row: BotRow): Bot {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    avatar: parseAvatar(row.avatar_json),
    instructions: row.instructions,
    providerId: row.provider_id,
    model: row.model,
    // An empty stored value reads as unset rather than failing the saveBot
    // RPC's non-empty reasoning level schema.
    reasoningLevel: row.reasoning_level ? row.reasoning_level : null,
    projectId: row.project_id,
    // Any unexpected stored value reads as published rather than stranding
    // a bot as an un-publishable draft.
    status: row.status === "draft" ? "draft" : "published",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
