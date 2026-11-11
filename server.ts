// bb-plugin-bots — backend entry.
//
// A "bot" is a name, an emoji, a block of instructions, and a model. Chatting
// with one spawns an ordinary BB thread; bb.agents.contributeInstructions then
// injects that bot's persona into every turn of that thread.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  AVATAR_SHAPES,
  clampInstructions,
  draftBlockers,
  MAX_INSTRUCTIONS,
  MAX_NAME,
  newBotId,
  pickEmoji,
  randomAvatar,
  renderBotInstructions,
  rowToBot,
  sortChats,
  type Bot,
  type BotRow,
} from "./bots.js";
import { DEFAULT_LISTENER_PORT, hookRpcMethods } from "./hook-contract.js";
import { createHookService } from "./hook.js";
import { createHookListener } from "./listener.js";
import { parseAllowedBaseUrls } from "./verify.js";

const ReasoningLevel = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
]);

const AvatarSchema = z.object({ version: z.literal(1), type: z.literal("blob"), shape: z.enum(AVATAR_SHAPES), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).strict();

const BotSchema = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string(),
  avatar: AvatarSchema.nullable().optional(),
  instructions: z.string(),
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: ReasoningLevel.nullable(),
  projectId: z.string().nullable(),
  status: z.enum(["draft", "published"]),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

// Lenient on purpose: the editor autosaves a half-typed bot on every
// keystroke, so nothing here can require a value. Validation moves to
// publish time (draftBlockers), where an incomplete bot actually matters.
const BotPatchSchema = z
  .object({
    name: z.string().max(MAX_NAME),
    emoji: z.string().min(1).max(16),
    avatar: AvatarSchema.nullable(),
    instructions: z.string().max(MAX_INSTRUCTIONS),
    providerId: z.string(),
    model: z.string(),
    reasoningLevel: ReasoningLevel.nullable(),
    projectId: z.string().nullable(),
  })
  .partial()
  .strict();

const ChatSchema = z.object({
  threadId: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  updatedAt: z.number().int(),
  // Mirror threadListResponseSchema's own field names (bb-plugin-sdk.d.ts)
  // exactly, both nullable: an unpinned/unarchived thread has null, not 0 or
  // false, so the frontend can tell "never pinned" from "pinned at epoch 0".
  pinnedAt: z.number().int().nullable(),
  archivedAt: z.number().int().nullable(),
});

// Mirrors the host's `promptInputSchema` (bb-plugin-sdk-app.d.ts) exactly.
// This is the part that carries images, so it's spelled out rather than
// left opaque like `environment`/`executionInputSources` below.
const PromptInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    mentions: z.array(z.unknown()).default([]),
    visibility: z.literal("agent-only").optional(),
  }),
  z.object({
    type: z.literal("image"),
    url: z.string(),
    visibility: z.literal("agent-only").optional(),
  }),
  z.object({
    type: z.literal("localImage"),
    path: z.string(),
    visibility: z.literal("agent-only").optional(),
  }),
  z.object({
    type: z.literal("localFile"),
    path: z.string(),
    name: z.string().optional(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().optional(),
    visibility: z.literal("agent-only").optional(),
  }),
]);

// The fully-resolved request `experimental_NewThreadComposer` submits.
// `executionInputSources` and `environment` are host-owned opaque shapes —
// mirroring them here would just rot, so they stay unknown and get cast at
// the `threads.spawn` boundary instead.
const NewThreadRequestSchema = z.object({
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  reasoningLevel: ReasoningLevel,
  permissionMode: z.string(),
  serviceTier: z.string().optional(),
  executionInputSources: z.record(z.string(), z.unknown()),
  environment: z.unknown(),
  input: z.array(PromptInputSchema).min(1),
});

export const rpcContract = defineRpcContract({
  // Webhook methods: getHook, saveHook, revealSecret, rotateSecret.
  ...hookRpcMethods,
  listBots: {
    input: z.null(),
    output: z.object({ bots: z.array(BotSchema) }),
  },
  getBot: {
    input: z.object({ botId: z.string() }).strict(),
    output: z.object({ bot: BotSchema.nullable() }),
  },
  // Writes an empty draft row immediately; the editor seeds and autosaves
  // provider/model/name itself via saveBot.
  createBot: {
    input: z.null(),
    output: z.object({ botId: z.string() }),
  },
  saveBot: {
    input: z.object({ botId: z.string(), patch: BotPatchSchema }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  publishBot: {
    input: z.object({ botId: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  deleteBot: {
    input: z.object({ botId: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  listChats: {
    input: z.object({ botId: z.string() }).strict(),
    output: z.object({
      chats: z.array(ChatSchema),
      archivedChats: z.array(ChatSchema),
    }),
  },
  // The rail's single round trip: every bot plus its chats in one call, so
  // the panel never has to fan out per-bot RPCs on load.
  listRail: {
    input: z.null(),
    output: z.object({
      bots: z.array(
        BotSchema.extend({
          chats: z.array(
            z.object({
              threadId: z.string(),
              title: z.string().nullable(),
              status: z.string(),
              updatedAt: z.number().int(),
            }),
          ),
          lastActivityAt: z.number().int(),
        }),
      ),
    }),
  },
  startChat: {
    input: z
      .object({ botId: z.string(), request: NewThreadRequestSchema })
      .strict(),
    output: z.object({ threadId: z.string() }),
  },
  // Pin/rename/archive/delete all come from the host's own
  // experimental_useSidebarThreadActions() hook on the frontend. Unarchive is
  // the one action that hook doesn't expose, so it's the only mutation this
  // plugin needs to provide itself.
  unarchiveChat: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  listOptions: {
    input: z.null(),
    output: z.object({
      providers: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          available: z.boolean(),
        }),
      ),
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
      personalProjectId: z.string().nullable(),
    }),
  },
  listModels: {
    input: z.object({ providerId: z.string() }).strict(),
    output: z.object({
      models: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          description: z.string(),
          isDefault: z.boolean(),
          defaultReasoningEffort: ReasoningLevel,
          reasoningEfforts: z.array(ReasoningLevel),
        }),
      ),
    }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS bots (
       id              TEXT PRIMARY KEY,
       name            TEXT NOT NULL,
       emoji           TEXT NOT NULL,
       instructions    TEXT NOT NULL,
       provider_id     TEXT NOT NULL,
       model           TEXT NOT NULL,
       reasoning_level TEXT,
       project_id      TEXT,
       created_at      INTEGER NOT NULL,
       updated_at      INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS bot_threads (
       thread_id  TEXT PRIMARY KEY,
       bot_id     TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS bot_threads_bot_id ON bot_threads(bot_id)`,
    // The DEFAULT backfills every existing row as published, so there's no
    // separate backfill statement or code path.
    `ALTER TABLE bots ADD COLUMN status TEXT NOT NULL DEFAULT 'published'`,
    `ALTER TABLE bots ADD COLUMN avatar_json TEXT`,
    // Webhook. A row per bot that ever opened its Webhook section; the
    // secret itself is derived from hook-master.key, so only its version is
    // stored.
    `CREATE TABLE IF NOT EXISTS bot_hooks (
       bot_id             TEXT PRIMARY KEY,
       enabled            INTEGER NOT NULL DEFAULT 0,
       secret_version     INTEGER NOT NULL DEFAULT 1,
       rate_limit_per_min INTEGER NOT NULL DEFAULT 10,
       created_at         INTEGER NOT NULL
     )`,
    // One row per accepted delivery: the replay guard and the claim lock.
    `CREATE TABLE IF NOT EXISTS hook_seen (
       bot_id     TEXT NOT NULL,
       signature  TEXT NOT NULL,
       idem_key   TEXT,
       claimed_at INTEGER NOT NULL,
       thread_id  TEXT,
       UNIQUE (bot_id, signature)
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS hook_seen_idem ON hook_seen(bot_id, idem_key) WHERE idem_key IS NOT NULL`,
  ]);

  // contributeInstructions is synchronous and sits on the thread-start path,
  // so SQLite is the durable store and these maps are the read path. A BB
  // plugin is one in-process module, so caching here is safe.
  const botsById = new Map<string, Bot>();
  const botIdByThreadId = new Map<string, string>();

  for (const row of db.prepare("SELECT * FROM bots").all() as BotRow[]) {
    botsById.set(row.id, rowToBot(row));
  }
  for (const row of db
    .prepare("SELECT thread_id, bot_id FROM bot_threads")
    .all() as { thread_id: string; bot_id: string }[]) {
    botIdByThreadId.set(row.thread_id, row.bot_id);
  }
  bb.log.info(
    `loaded ${botsById.size} bots across ${botIdByThreadId.size} threads`,
  );

  // The whole point of the plugin. Returning null for unmapped threads is
  // load-bearing: without it every thread in BB would inherit a bot persona.
  bb.agents.contributeInstructions(({ threadId }) => {
    const botId = botIdByThreadId.get(threadId);
    if (botId === undefined) return null;
    const bot = botsById.get(botId);
    if (bot === undefined) return null;
    return renderBotInstructions(bot);
  });

  function readBot(botId: string): Bot {
    const bot = botsById.get(botId);
    if (bot === undefined) throw new Error(`Unknown bot: ${botId}`);
    return bot;
  }

  function announce() {
    bb.realtime.publish("bots", { changedAt: Date.now() });
  }

  // Shared by startChat and the webhook: the bot_threads row is what makes
  // contributeInstructions apply the persona to the new thread.
  function recordThread(botId: string, threadId: string) {
    db.prepare(
      "INSERT INTO bot_threads (thread_id, bot_id, created_at) VALUES (?, ?, ?)",
    ).run(threadId, botId, Date.now());
    botIdByThreadId.set(threadId, botId);
  }

  // Webhook settings. The SDK's descriptors have no number type and no
  // validator, so the port is a string and a bad value is rejected where it
  // is read (parseListenerPort, parseAllowedBaseUrls); the editor shows why.
  const settings = bb.settings.define({
    allowedBaseUrls: {
      type: "string",
      label: "Allowed base URLs",
      description:
        "Hosts that may call your bots' webhooks. Comma-separated full URLs, for example https://hooks.example.com. Point your tunnel at the listener port.",
      default: "",
    },
    listenerPort: {
      type: "string",
      label: "Listener port",
      description: "The webhook listener binds 127.0.0.1 on this port (1024–65535).",
      default: DEFAULT_LISTENER_PORT,
    },
  });

  const hooks = createHookService({
    bb,
    db,
    getBot: (botId) => botsById.get(botId),
    // A webhook thread starts without anyone watching, so tell open panels
    // to refresh their chat lists.
    recordThread: (botId, threadId) => {
      recordThread(botId, threadId);
      announce();
    },
    readBaseUrls: async () => parseAllowedBaseUrls((await settings.get()).allowedBaseUrls),
    listenerStatus: () => listener.status(),
  });

  // The plugin's own listener on 127.0.0.1. BB's HTTP server never sees
  // webhook traffic. It opens only while a published bot has its hook on and
  // a base URL is valid; reconcile() runs wherever one of those can change.
  const listener = createHookListener({
    bb,
    readSettings: () => settings.get(),
    liveBotCount: hooks.liveBotCount,
    isLive: hooks.isLive,
    processDelivery: hooks.processDelivery,
  });
  bb.onDispose(() => listener.dispose());
  settings.onChange(() => {
    void listener.reconcile();
  });

  bb.rpc.register(rpcContract, {
    listBots: () => ({
      bots: [...botsById.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    }),

    getBot: ({ botId }) => ({ bot: botsById.get(botId) ?? null }),

    // Writes a bare row immediately so the editor has a botId to autosave
    // against from the very first keystroke. The editor seeds and saves
    // provider/model/name itself via saveBot right after.
    createBot: () => {
      const now = Date.now();
      const bot: Bot = {
        id: newBotId(),
        name: "",
        emoji: pickEmoji(),
        avatar: randomAvatar(),
        instructions: "",
        providerId: "",
        model: "",
        reasoningLevel: null,
        projectId: null,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      };
      db.prepare(
        `INSERT INTO bots (id, name, emoji, instructions, provider_id, model,
                           reasoning_level, project_id, status, created_at, updated_at, avatar_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        bot.id,
        bot.name,
        bot.emoji,
        bot.instructions,
        bot.providerId,
        bot.model,
        bot.reasoningLevel,
        bot.projectId,
        bot.status,
        bot.createdAt,
        bot.updatedAt,
        JSON.stringify(bot.avatar),
      );
      botsById.set(bot.id, bot);
      announce();
      return { botId: bot.id };
    },

    // Applies only the keys the editor actually sent — an autosave from a
    // half-typed form must never blow away fields the user hasn't touched
    // yet — and never touches status; that's publishBot's job alone.
    saveBot: ({ botId, patch }) => {
      const existing = readBot(botId);
      const bot: Bot = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.emoji !== undefined ? { emoji: patch.emoji } : {}),
        ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
        ...(patch.instructions !== undefined
          ? { instructions: clampInstructions(patch.instructions) }
          : {}),
        ...(patch.providerId !== undefined
          ? { providerId: patch.providerId }
          : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.reasoningLevel !== undefined
          ? { reasoningLevel: patch.reasoningLevel }
          : {}),
        ...(patch.projectId !== undefined
          ? { projectId: patch.projectId }
          : {}),
        updatedAt: Date.now(),
      };
      db.prepare(
        `UPDATE bots
            SET name = ?, emoji = ?, instructions = ?, provider_id = ?,
                model = ?, reasoning_level = ?, project_id = ?, updated_at = ?, avatar_json = ?
          WHERE id = ?`,
      ).run(
        bot.name,
        bot.emoji,
        bot.instructions,
        bot.providerId,
        bot.model,
        bot.reasoningLevel,
        bot.projectId,
        bot.updatedAt,
        bot.avatar ? JSON.stringify(bot.avatar) : null,
        bot.id,
      );
      botsById.set(bot.id, bot);
      announce();
      return { ok: true };
    },

    // Publishing an already-published bot is a no-op success — the editor
    // doesn't need to know which state it started in.
    publishBot: async ({ botId }) => {
      const existing = readBot(botId);
      if (existing.status === "published") return { ok: true };
      const blockers = draftBlockers(existing);
      if (blockers.length > 0) {
        throw new Error(`Missing: ${blockers.join(", ")}`);
      }
      const bot: Bot = {
        ...existing,
        status: "published",
        updatedAt: Date.now(),
      };
      db.prepare("UPDATE bots SET status = ?, updated_at = ? WHERE id = ?").run(
        bot.status,
        bot.updatedAt,
        bot.id,
      );
      botsById.set(bot.id, bot);
      announce();
      await listener.reconcile();
      return { ok: true };
    },

    // Deletes the bot and its thread mappings. The threads themselves are real
    // conversations, so they stay — they just stop receiving the persona.
    deleteBot: async ({ botId }) => {
      hooks.forgetBot(botId);
      db.prepare("DELETE FROM bot_threads WHERE bot_id = ?").run(botId);
      db.prepare("DELETE FROM bots WHERE id = ?").run(botId);
      botsById.delete(botId);
      for (const [threadId, mapped] of botIdByThreadId) {
        if (mapped === botId) botIdByThreadId.delete(threadId);
      }
      announce();
      await listener.reconcile();
      return { ok: true };
    },

    // Two threads.list calls (active, archived) run concurrently — still
    // never a per-thread threads.get loop, and still filtered by our own
    // mapping so a bot only ever sees its own chats.
    listChats: async ({ botId }) => {
      const mine = new Set(
        (
          db
            .prepare("SELECT thread_id FROM bot_threads WHERE bot_id = ?")
            .all(botId) as { thread_id: string }[]
        ).map((row) => row.thread_id),
      );
      if (mine.size === 0) return { chats: [], archivedChats: [] };
      const [activeThreads, archivedThreads] = await Promise.all([
        bb.sdk.threads.list({
          originPluginId: bb.pluginId,
          limit: 200,
          archived: false,
        }),
        bb.sdk.threads.list({
          originPluginId: bb.pluginId,
          limit: 200,
          archived: true,
        }),
      ]);
      const toChat = (thread: (typeof activeThreads)[number]) => ({
        threadId: thread.id,
        title: thread.title ?? thread.titleFallback,
        status: thread.status,
        updatedAt: thread.updatedAt,
        pinnedAt: thread.pinnedAt,
        archivedAt: thread.archivedAt,
      });
      return {
        chats: sortChats(
          activeThreads.filter((thread) => mine.has(thread.id)).map(toChat),
        ),
        // Archived chats are never pinned in the UI (pin/unpin only act on
        // the active list), so a plain updatedAt-desc sort is enough here —
        // sortChats' pinned bucket would be a no-op.
        archivedChats: archivedThreads
          .filter((thread) => mine.has(thread.id))
          .map(toChat)
          .sort((a, b) => b.updatedAt - a.updatedAt),
      };
    },

    // The rail's one round trip: a single threads.list call, bucketed by
    // bot_threads in memory. Never a per-bot threads.list or a per-thread
    // threads.get.
    listRail: async () => {
      const chatsByBotId = new Map<
        string,
        { threadId: string; title: string | null; status: string; updatedAt: number }[]
      >();
      const botIdByThreadIdRows = db
        .prepare("SELECT thread_id, bot_id FROM bot_threads")
        .all() as { thread_id: string; bot_id: string }[];
      const botIdByOwnThreadId = new Map(
        botIdByThreadIdRows.map((row) => [row.thread_id, row.bot_id]),
      );
      // Excludes archived threads: an archived chat is put away on purpose,
      // so it must not resurface as the rail's subtitle or bump
      // lastActivityAt back to the top of the bot list.
      const threads = await bb.sdk.threads.list({
        originPluginId: bb.pluginId,
        limit: 200,
        archived: false,
      });
      for (const thread of threads) {
        const botId = botIdByOwnThreadId.get(thread.id);
        if (botId === undefined) continue;
        const chats = chatsByBotId.get(botId) ?? [];
        chats.push({
          threadId: thread.id,
          title: thread.title ?? thread.titleFallback,
          status: thread.status,
          updatedAt: thread.updatedAt,
        });
        chatsByBotId.set(botId, chats);
      }
      const bots = [...botsById.values()].map((bot) => {
        const chats = (chatsByBotId.get(bot.id) ?? []).sort(
          (a, b) => b.updatedAt - a.updatedAt,
        );
        const newestChatAt = chats[0]?.updatedAt ?? 0;
        return {
          ...bot,
          chats,
          lastActivityAt: Math.max(bot.updatedAt, newestChatAt),
        };
      });
      bots.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      return { bots };
    },

    // The composer already resolved a concrete projectId and environment
    // (including "Don't work in a project", which submits the personal
    // project id, not null), so there's nothing left to resolve here. Note
    // this makes the bot's stored provider/model/project/reasoning SEEDS for
    // the composer, not enforcement — a chat can be started on a different
    // model or project than the bot was configured with, and the persona
    // still applies because contributeInstructions maps per-thread, not
    // per-model.
    startChat: async ({ botId, request }) => {
      const bot = readBot(botId);
      if (bot.status === "draft") {
        throw new Error("Publish this bot before starting a chat");
      }

      // The composer already validated these against the host's literal
      // unions (permission mode, mention structure, environment /
      // executionInputSources internals). Re-typing them from our
      // deliberately-loose zod schema would just rot, so cast once at the
      // spawn boundary instead of mirroring the host's internal types here.
      const spawnArgs = {
        projectId: request.projectId,
        providerId: request.providerId,
        model: request.model,
        reasoningLevel: request.reasoningLevel,
        permissionMode: request.permissionMode,
        ...(request.serviceTier === undefined
          ? {}
          : { serviceTier: request.serviceTier }),
        executionInputSources: request.executionInputSources,
        environment: request.environment,
        input: request.input,
        // Deliberately omitted: title is optional in CreateThreadRequest and
        // BB auto-titles the thread from its first message. Passing bot.name
        // here used to make every chat literally named after the bot.
      };
      const thread = await bb.sdk.threads.spawn(
        spawnArgs as Parameters<typeof bb.sdk.threads.spawn>[0],
      );

      recordThread(bot.id, thread.id);
      bb.log.info(`started chat ${thread.id} for bot ${bot.id}`);
      return { threadId: thread.id };
    },

    // The frontend's experimental_useSidebarThreadActions() hook covers
    // pin/rename/archive/delete directly against the host, so this is the
    // only mutation the plugin itself needs to expose. The ownership check
    // below is load-bearing: without it, any caller of this RPC could pass
    // an arbitrary threadId and unarchive a thread that has nothing to do
    // with this plugin's bots.
    unarchiveChat: async ({ threadId }) => {
      // botIdByThreadId is the in-memory mirror of bot_threads kept in sync
      // by startChat/deleteBot/thread.deleted, so checking it here is the
      // same "is this ours" test contributeInstructions already relies on —
      // no need for a separate SELECT against the table it mirrors.
      if (botIdByThreadId.get(threadId) === undefined) {
        throw new Error(`Unknown chat: ${threadId}`);
      }
      await bb.sdk.threads.unarchive({ threadId });
      announce();
      return { ok: true };
    },

    listOptions: async () => {
      const [providers, projects, allProjects] = await Promise.all([
        bb.sdk.providers.list(),
        bb.sdk.projects.list(),
        bb.sdk.projects.list({ includePersonal: true }),
      ]);
      const personal = allProjects.find(
        (project) => project.kind === "personal",
      );
      return {
        providers: providers.map((provider) => ({
          id: provider.id,
          displayName: provider.displayName,
          available: provider.available,
        })),
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
        })),
        personalProjectId: personal?.id ?? null,
      };
    },

    listModels: async ({ providerId }) => {
      const options = await bb.sdk.providers.models({ providerId });
      return {
        models: options.models.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          description: model.description,
          isDefault: model.isDefault,
          defaultReasoningEffort: model.defaultReasoningEffort,
          reasoningEfforts: model.supportedReasoningEfforts.map(
            (effort) => effort.reasoningEffort,
          ),
        })),
      };
    },

    // Webhook. Each throws for an unknown bot via readBot. A draft bot has a
    // hook too — the editor shows it — but the listener refuses to fire it.
    getHook: async ({ botId }) => {
      readBot(botId);
      return { hook: await hooks.getState(botId) };
    },

    // The contract schema already bounds rateLimitPerMin, so nothing is
    // clamped here.
    saveHook: async ({ botId, enabled, rateLimitPerMin }) => {
      readBot(botId);
      hooks.save(botId, enabled, rateLimitPerMin);
      await listener.reconcile();
      return { hook: await hooks.getState(botId) };
    },

    revealSecret: ({ botId }) => {
      readBot(botId);
      return { secret: hooks.revealSecret(botId) };
    },

    rotateSecret: async ({ botId }) => {
      readBot(botId);
      return hooks.rotateSecret(botId);
    },
  });

  // Open the port now if a bot already has its hook on. Never fails the load.
  await listener.reconcile();

  // Keep the mapping from growing without bound. Archived threads are still
  // resumable, so only deletion drops the persona link.
  bb.events.on("thread.deleted", ({ thread }) => {
    if (!botIdByThreadId.delete(thread.id)) return;
    db.prepare("DELETE FROM bot_threads WHERE thread_id = ?").run(thread.id);
    // Without this, a second open BB window keeps showing a chat that was
    // just deleted from the first window until its next unrelated refresh.
    announce();
  });

  // Deliberately does NOT touch bot_threads: archiving just puts a chat away,
  // it doesn't end it, so the persona mapping must survive until the thread
  // comes back via unarchiveChat (or is actually deleted). Only announce for
  // threads that are ours — bb archives threads belonging to every plugin
  // and to no plugin at all, and this channel exists solely to tell this
  // plugin's own panels to refresh.
  bb.events.on("thread.archived", ({ thread }) => {
    if (botIdByThreadId.get(thread.id) === undefined) return;
    announce();
  });
}
