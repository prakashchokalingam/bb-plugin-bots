# Bots for BB

Create a small team of AI bots inside BB.

Each bot has its own name, instructions, model provider, model, and reasoning
level. Create a bot once, give it a clear job, and use it whenever you need it
without repeating the same instructions every time.

Your writing bot can stay focused on clear writing. Your research bot can use a
different model. Your coding bot can use the model and reasoning level that
works best for code.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/front-page-dark.png">
  <img alt="The full BB window with a navigation rail, five colorful bot avatars, and a list of recent threads." src="assets/screenshots/front-page-light.png">
</picture>

<sub>A team of bots in the BB window. This preview uses sample data and a mock thread sidebar and composer.</sub>

## Why this exists

I like custom GPTs and Grok bots because they let you create a reusable persona
for a specific job. But they are tied to one model provider.

BB gives you more control. You can create your own bots, keep their instructions
in one place, and choose the provider and model for each one.

This plugin brings those two ideas together:

- reusable bots with a clear purpose
- your own instructions for every bot
- a different model provider or model for different kinds of work
- a familiar chat experience inside BB

The goal is simple: build a personal fleet of bots that work the way you work.

## What you can do

With Bots, you can:

- create bots for writing, research, coding, planning, reviews, or any repeatable work
- give every bot its own instructions and personality
- choose a provider, model, and reasoning level per bot
- connect a bot to a project when it needs repository context
- keep bots without a project for everyday conversations
- create drafts before making a bot available to chat with
- keep chat history as normal BB threads
- choose an animated blob avatar or an emoji for each bot
- expand a bot in the rail to open recent threads and see their states

A bot is not a separate chat app. It lives in BB and uses BB's existing thread,
composer, attachment, archive, and delete experience.

## Install

Install from the BB Community marketplace:

```sh
bb plugin install bots
```

Install directly from this repository:

```sh
bb plugin install git:https://github.com/prakashchokalingam/bb-plugin-bots.git
```

Requires BB `>=0.48.1`.

## Create your first bot

1. Open **Bots** from the BB sidebar.
2. Click **New bot**.
3. Give the bot a name and write its instructions.
   Select the avatar to choose a shape, color, or emoji.
4. Choose its provider, model, and reasoning level.
5. Optionally select a project if the bot should work with a repository.
6. Click **Publish**.
7. Start a chat.

<img alt="The avatar picker with blob shapes, preset colors, and a custom color field." src="assets/screenshots/avatar-picker-light.png">

<sub>Choose a blob shape and color, or select an emoji. This preview uses sample data.</sub>

<sub>New bots start as drafts. Publish stays disabled until the bot has a name, a provider, and a model.</sub>

For example, you could create:

| Bot | What it does |
| --- | --- |
| Writing partner | Rewrites messages in clear, natural English |
| Code reviewer | Reviews pull requests using your team's standards |
| Research assistant | Investigates a topic and gives a sourced summary |
| Product thinker | Helps turn rough ideas into product decisions |
| Personal assistant | Handles your everyday planning and notes |

## How bots work

Every bot has its own saved instructions. When you start a chat with that bot,
those instructions are applied automatically for that conversation.

You can edit a bot at any time. Changes apply to future chats; an active chat
keeps the instructions it started with.

Bots can be connected to a BB project, but they do not need to be. A project
gives the bot access to repository context. A bot without a project is useful
for writing, thinking, planning, and other general conversations.

The provider, model, project, and reasoning level are used as defaults when you
start a chat. You can still change them before sending the first message.

## Drafts and published bots

New bots start as drafts. This gives you space to set up their instructions,
provider, and model before using them.

A draft cannot start a chat until it has:

- a name
- a provider
- a model

Once published, the bot is ready to use from the Bots sidebar.

## Chats stay in BB

Bot chats are normal BB threads. You can open them, archive them, delete them,
and find them in the sidebar like any other BB conversation.

Deleting a bot does not delete its existing chats. Those chats stay available,
but they no longer receive that bot's instructions.

## Webhook

Each bot has one webhook. Each signed request starts one new chat in that bot,
with the bot's provider, model, reasoning level and project. A bot with no
project uses your personal project. The chat runs in `accept-edits` mode.

### How it works

The plugin opens its own listener on `127.0.0.1`, port `38990` by default. bb's
own HTTP server never sees webhook traffic. The listener is open only while at
least one published bot has its webhook on and at least one base URL is valid.
Otherwise the port is closed.

```text
caller ─▶ your tunnel ─▶ Bots listener 127.0.0.1:38990 ─▶ new chat
```

A request passes these checks, in this order:

1. The `Host` header must be one of your allowed base URLs. Otherwise `421`.
2. The method must be `POST` and the path exactly `/hooks/<botId>`. Otherwise `404`.
3. The bot must exist, be published and have its webhook on. Otherwise the same `404`.
4. The body must be at most 256 KB, as `application/json` or `text/plain`.
5. The HMAC signature must be valid.

### Set up

1. In Settings → Installed plugins → Bots, set **Allowed base URLs**. Use a
   comma-separated list of full URLs, for example
   `https://hooks.example.com, http://127.0.0.1:38990`. Each must start with
   `https://`. `http://localhost` and `http://127.0.0.1` are also accepted. Do
   not add a path, a query or a fragment. A bad entry is ignored, and the bot
   editor says so.
2. Optional: change **Listener port** (1024 to 65535, default `38990`).
3. Point your tunnel at `http://127.0.0.1:<listener port>`.
4. Open the bot editor, go to **Webhook**, and turn on **Enabled**. Only a
   published bot can fire. The editor shows one URL for each allowed base URL,
   and says whether the listener is running.
5. Use **Reveal** to see the secret and **Rotate** to replace it. The old
   secret stops working at once.

To test on this machine, add `http://127.0.0.1:38990` to **Allowed base URLs**.

Sign `"{timestamp}.{body}"` with HMAC-SHA256 and the secret:

```sh
URL='<url from the bot editor>'   # https://hooks.example.com/hooks/bot_…
SECRET='whsec_REPLACE_ME'   # use Reveal in the bot editor
BODY='{"text":"hello"}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-Hook-Timestamp: $TS" \
  -H "X-Hook-Signature: sha256=$SIG" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "$BODY"
```

The body goes to the bot as data, not as instructions. The reply comes back
as soon as the chat exists. It does not wait for the bot to finish.

| Status | Meaning |
|---|---|
| 202 | Accepted. Body: `{ "threadId", "eventId" }` |
| 200 | The same request (same signature or `Idempotency-Key`) already started a chat. Body: `{ "threadId" }` |
| 400 | `Content-Type` is JSON, but the body is not valid JSON |
| 401 | Bad or missing signature, or timestamp outside 5 minutes |
| 404 | Wrong path or method, or the bot is unknown, a draft, or has its webhook off. The reply is the same for each case |
| 409 | The same request is still in progress. Retry after `Retry-After` (1 s) |
| 413 | The body is larger than 256 KB |
| 415 | `Content-Type` is not `application/json` or `text/plain` |
| 421 | `Host` is not one of the allowed base URLs. The body is empty |
| 429 | The bot's rate limit is reached (see `Retry-After`), or too many failed signatures from all callers |
| 500 | An error inside the listener |
| 502 | bb could not start the chat. Retry is safe |

Limits:

- Body: 256 KB.
- Connections: 64 at the same time. Headers within 10 s, whole request within 30 s.
- Timestamp: within 300 seconds of the bb clock.
- Rate: 10 requests a minute per bot by default, from 1 to 600. Set it in the
  bot editor. The counter resets when bb restarts.
- Failed signatures: 120 a minute across all bots, then 429.
- Repeat detection: 24 hours.

The `Host` check keeps scanners and browser pages out. It is not
authentication. The signature is. A laptop that sleeps breaks the tunnel, so
senders must retry.

If the port is in use, the bot editor shows `Port <port> is in use`. Choose
another port in the plugin settings. A plugin reload briefly keeps the old
listener open, so the new one retries the port for a few seconds.

## Development

```sh
bb plugin install .
bb plugin dev
bb plugin logs bots -f

npm test
npm run typecheck
```

## License

MIT
