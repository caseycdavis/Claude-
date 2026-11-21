# Parce Operational Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single program on Casey's Mac mini that links to his WhatsApp chat with Juan and serves a private web app where Casey reads Juan's Spanish with an English translation and sends English as previewed Medellín Spanish.

**Architecture:** One Node process with four parts behind small interfaces: a `Transport` (WhatsApp via Baileys, or a stand-in), a `Store` (one SQLite file), a `Translator` (Claude, or a stand-in), and an HTTP server that serves the React app, a JSON API and a server-sent-events stream. A `ConversationService` is the only code that connects them.

**Tech Stack:** Node 22, TypeScript, Fastify, `node:sqlite` (built in, no native build step), `baileys` pinned to `7.0.0-rc14`, `@anthropic-ai/sdk` with `zod`, React + Vite, Vitest, Playwright (already installed in the build session).

**Spec:** `docs/superpowers/specs/2026-11-19-bilingual-messenger-design.md`. This plan covers spec phases 1 and 2 (build order, section 13). Glossary editing, Explain, notifications, voice, photos and hardening get their own plans.

**Deferred from phases 1 and 2:** importing chat history at link time (the link runs with history sync off), and the fixed sample set for judging translations (waiting on Casey's lines). Server-side refusal fallbacks are also left off until the translator has been run live.

## Global Constraints

- Node 22 or later; `baileys` exactly `7.0.0-rc14`.
- Only the allowlisted chat is ever stored, shown or sent to the translator. Everything else is dropped in memory.
- The program can send only to the allowlisted chat.
- An incoming original is stored and shown before its translation is requested.
- Nothing is sent to Juan untranslated unless Casey chooses "send as written".
- Outgoing messages are never queued for later. A failed send leaves the draft with Casey.
- Preview before send is on by default.
- The literal reading of outgoing Spanish comes from a request that sees only the Spanish.
- No model identifier is written into the repository. The model is chosen from the provider's live model list and stored in settings.
- The Anthropic key, the passphrase hash and the WhatsApp session files live only in the data directory on the machine, never in the repository.
- Real chat lines never enter the repository. Tests use invented lines.
- No emoji in UI chrome.

## Review Focus

1. A message from any other chat, a group Juan is in, or a status broadcast arrives: it is dropped, with no row written and no translator call.
2. Juan's chat is addressed by LID with the phone-number form alongside, or the reverse: it is still recognised as Juan's chat.
3. The translator throws, times out, refuses or returns nothing usable: the original stays visible marked failed with a retry, and no outgoing text is sent.
4. Send is pressed while the link is down, or the transport throws: the caller gets an error, no "sent" row exists, and nothing is sent later.
5. The same WhatsApp message is delivered twice (echo of an app-sent message, replay after reconnect, history backfill): one row, one translation.

Each line has a named test in the task that owns the code (Tasks 3, 3, 4, 4, 4).

---

## File Structure

```
package.json  tsconfig.json  tsconfig.server.json  vite.config.ts  vitest.config.ts  .gitignore  README.md
src/server/types.ts            domain types and the three interfaces
src/server/config.ts           environment to Config
src/server/store.ts            SQLite store
src/server/events.ts           typed in-process event bus
src/server/translator/prompt.ts   prompt construction, skip rule, result schemas
src/server/translator/claude.ts   Claude-backed Translator, model listing
src/server/translator/fake.ts     deterministic Translator for demo and tests
src/server/transport/wa-map.ts    pure functions: chat matching and message mapping
src/server/transport/whatsapp.ts  Baileys-backed Transport
src/server/transport/fake.ts      stand-in Transport for demo and tests
src/server/conversation.ts     ConversationService
src/server/http/auth.ts        passphrase hashing, sessions, login rate limit
src/server/http/app.ts         Fastify app: routes, SSE, static files
src/server/index.ts            entry point
src/web/index.html  main.tsx  api.ts  styles.css  App.tsx
src/web/screens/Setup.tsx  Login.tsx  Chat.tsx
src/web/components/Bubble.tsx  Composer.tsx  StatusBanner.tsx
tests/*.test.ts                unit and API tests
tests/e2e/smoke.spec.ts        browser test in demo mode
scripts/install-mac.sh         registers the program to start at login on macOS
scripts/smoke-translate.ts     live translator check, run on the Mac mini with a real key
docs/HANDOFF.md                instructions for the session that installs it on the Mac mini
```

---

### Task 1: Project skeleton, types, config and store

**Files:** Create `package.json`, `tsconfig.json`, `tsconfig.server.json`, `vitest.config.ts`, `.gitignore`, `src/server/types.ts`, `src/server/config.ts`, `src/server/store.ts`, `src/server/events.ts`. Test: `tests/store.test.ts`.

**Interfaces (Produces):**

```ts
// types.ts
export type Direction = 'in' | 'out';
export type Tone = 'base' | 'warmer' | 'firmer' | 'playful' | 'shorter';
export type MessageStatus = 'translating' | 'done' | 'failed' | 'skipped' | 'sent';
export type Note = { term: string; meaning: string };
export type Message = {
  id: string; waId: string | null; direction: Direction;
  source: 'juan' | 'app' | 'phone'; kind: 'text' | 'other';
  original: string; translation: string | null; backTranslation: string | null;
  notes: Note[]; ambiguity: string | null; status: MessageStatus; ts: number; read: boolean;
};
export type ContextLine = { speaker: 'Casey' | 'Juan'; text: string };
export type Profile = { instructions: string; aboutUs: string; glossary: Note[] };
export type IncomingResult = { english: string; notes: Note[]; ambiguity: string | null };
export type OutgoingResult = { spanish: string; notes: Note[]; ambiguity: string | null };
export interface Translator {
  incoming(i: { text: string; context: ContextLine[]; profile: Profile }): Promise<IncomingResult>;
  outgoing(i: { text: string; tone: Tone; context: ContextLine[]; profile: Profile }): Promise<OutgoingResult>;
  backTranslate(spanish: string): Promise<string>;
}
export type LinkState = 'unlinked' | 'linking' | 'linked' | 'down';
export type LinkStatus = { state: LinkState; qr: string | null; pairingCode: string | null; since: number };
export type InboundMessage = { waId: string; fromMe: boolean; ts: number; kind: 'text' | 'other'; text: string };
export type TransportEvent = { type: 'message'; message: InboundMessage } | { type: 'status'; status: LinkStatus };
export interface Transport {
  start(): Promise<void>; stop(): Promise<void>;
  status(): LinkStatus;
  subscribe(handler: (e: TransportEvent) => void): void;
  setChat(phoneDigits: string | null): void;
  sendText(text: string): Promise<{ waId: string; ts: number }>;
  markRead(waIds: string[]): Promise<void>;
  requestPairingCode(phoneDigits: string): Promise<string>;
  logout(): Promise<void>;
}

// config.ts
export type Config = { port: number; host: string; dataDir: string; demo: boolean; webDir: string };
export function loadConfig(env: NodeJS.ProcessEnv): Config;
// defaults: PARCE_PORT 8787, PARCE_HOST 0.0.0.0, PARCE_DATA_DIR ~/.parce, PARCE_DEMO unset

// store.ts
export class Store {
  constructor(file: string);                       // ':memory:' in tests
  getSetting(key: string): string | null;
  setSetting(key: string, value: string | null): void;
  insertMessage(m: Message): boolean;              // false when waId already exists
  updateMessage(id: string, patch: Partial<Message>): Message;
  getMessage(id: string): Message | null;
  listMessages(opts: { before?: number; limit: number }): Message[];   // oldest first
  recentContext(limit: number): ContextLine[];     // oldest first, text kinds only
  markRead(ids: string[]): string[];               // returns waIds newly marked
  createSession(tokenHash: string, expires: number): void;
  hasSession(tokenHash: string, now: number): boolean;
  deleteSession(tokenHash: string): void;
  close(): void;
}

// events.ts
export type AppEvent = { type: 'message'; message: Message } | { type: 'link'; status: LinkStatus };
export class EventBus { publish(e: AppEvent): void; subscribe(fn: (e: AppEvent) => void): () => void; }
```

- [ ] **Step 1:** Write `tests/store.test.ts`: `settings round-trip and delete with null`; `insertMessage returns false for a repeated waId and keeps one row`; `listMessages returns oldest first and honours before and limit`; `recentContext labels in as Juan and out as Casey and skips kind other`; `markRead returns only newly marked waIds`; `session expires at its expiry time`.
- [ ] **Step 2:** Run `npx vitest run tests/store.test.ts`; expect failure (module missing).
- [ ] **Step 3:** Create the package files and implement the four source files. `package.json` has `"type": "module"`, scripts `build` (tsc server build then `vite build`), `start` (`node dist/server/index.js`), `test` (`vitest run`), `demo` (`PARCE_DEMO=1` start). The store opens `node:sqlite` `DatabaseSync`, sets `journal_mode=WAL`, creates tables `settings`, `messages` (unique index on `wa_id`), `sessions` if absent, and stores `notes` as JSON text.
- [ ] **Step 4:** Run the test; expect pass. Run `npx tsc -p tsconfig.server.json --noEmit`; expect no errors.
- [ ] **Step 5:** Commit.

### Task 2: Translator

**Files:** Create `src/server/translator/prompt.ts`, `claude.ts`, `fake.ts`. Test: `tests/prompt.test.ts`, `tests/claude.test.ts`.

**Interfaces:** Consumes `Translator`, `Profile`, `ContextLine`, `Tone`, result types. Produces:

```ts
// prompt.ts
export const DEFAULT_INSTRUCTIONS: string;   // spec section 9, "Standing instructions", verbatim meaning
export function shouldSkip(text: string): boolean;   // true for empty, emoji-only, bare URL
export function systemPrompt(profile: Profile): string;   // stable text: instructions, about us, glossary
export function incomingUser(text: string, context: ContextLine[]): string;
export function outgoingUser(text: string, tone: Tone, context: ContextLine[]): string;
export function backUser(spanish: string): string;        // contains the Spanish and nothing from the thread
export const IncomingSchema, OutgoingSchema, BackSchema;  // zod objects

// claude.ts
export type MessagesClient = { messages: { parse(args: any): Promise<any> }; models: { list(): AsyncIterable<{ id: string; display_name: string; created_at: string }> } };
export class TranslationError extends Error { constructor(public reason: 'auth' | 'refused' | 'empty' | 'rate' | 'api', message: string) }
export class ClaudeTranslator implements Translator {
  constructor(deps: { client: MessagesClient; model: () => string });
}
export async function listModels(client: MessagesClient): Promise<{ id: string; name: string }[]>;   // newest first
export function pickDefaultModel(models: { id: string; name: string }[]): string | null;             // newest id starting 'claude-opus', else first
export function makeClient(apiKey: string): MessagesClient;

// fake.ts
export class FakeTranslator implements Translator { failNext: boolean }
// incoming -> english "[EN] <text>"; outgoing -> spanish "[ES:<tone>] <text>"; back -> "[BACK] <spanish>"
```

- [ ] **Step 1:** Write `tests/prompt.test.ts`: `shouldSkip is true for "", "   ", an emoji-only string and "https://example.com/x", false for "ok"`; `systemPrompt contains the instructions, the about-us text and every glossary term, and is identical for two calls with the same profile`; `backUser contains the Spanish and none of the context lines`; `outgoingUser names the tone only when it is not base`.
- [ ] **Step 2:** Write `tests/claude.test.ts` with a stub client: `incoming sends the configured model, a cached system block and the incoming schema, and returns parsed_output`; `outgoing then backTranslate make two separate calls and the second call's messages do not contain the English`; `stop_reason refusal throws TranslationError refused`; `null parsed_output throws TranslationError empty`; `pickDefaultModel prefers the newest id starting claude-opus`.
- [ ] **Step 3:** Run both; expect failure.
- [ ] **Step 4:** Implement. Requests use `client.messages.parse` with `max_tokens: 16000`, `system: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]`, `output_config: { format: zodOutputFormat(Schema) }`, no `thinking`, `effort` or sampling parameters. Map SDK errors with `instanceof` on `Anthropic.AuthenticationError`, `Anthropic.RateLimitError`, `Anthropic.APIError`.
- [ ] **Step 5:** Run both; expect pass. Commit.

### Task 3: WhatsApp mapping and transports

**Files:** Create `src/server/transport/wa-map.ts`, `whatsapp.ts`, `fake.ts`. Test: `tests/wa-map.test.ts`.

**Interfaces:** Consumes `Transport`, `InboundMessage`, `LinkStatus`. Produces:

```ts
// wa-map.ts
export function digitsOnly(input: string): string;
export function phoneJid(digits: string): string;                       // '<digits>@s.whatsapp.net'
export type ChatMatcher = { digits: string | null; lid: string | null };
export function matchesChat(key: { remoteJid?: string | null; remoteJidAlt?: string | null }, m: ChatMatcher): boolean;
export function learnLid(key: { remoteJid?: string | null; remoteJidAlt?: string | null }, m: ChatMatcher): string | null;
export function toInbound(msg: { key: any; message?: any; messageTimestamp?: any }): InboundMessage | null;
// text from conversation or extendedTextMessage.text; image/video caption as kind 'other' with a label;
// audio 'Voice note', sticker, document, location, contact, poll as kind 'other'; protocol and reaction messages -> null

// whatsapp.ts
export class WhatsAppTransport implements Transport { constructor(opts: { authDir: string; onLid?: (lid: string) => void; lid?: string | null }) }
// fake.ts
export class FakeTransport implements Transport { sent: string[]; failSend: boolean; emitFromJuan(text: string): void; emitFromPhone(text: string): void; setState(s: LinkState): void }
```

- [ ] **Step 1:** Write `tests/wa-map.test.ts`: **Review Focus 1** `matchesChat is false for another number, a group jid ending @g.us, status@broadcast and a null matcher`; **Review Focus 2** `matchesChat is true when remoteJid is a LID and remoteJidAlt is Juan's phone jid, and when remoteJid is the learned LID alone`; `learnLid returns the LID when the phone form matched through remoteJidAlt`; `toInbound reads conversation and extendedTextMessage text`; `toInbound labels an audio message "Voice note" with kind other`; `toInbound returns null for a reaction and for a protocol message`; `toInbound converts a Long-like timestamp to milliseconds`.
- [ ] **Step 2:** Run; expect failure. Implement `wa-map.ts` and `fake.ts`. Run; expect pass.
- [ ] **Step 3:** Implement `whatsapp.ts` on `makeWASocket` with `useMultiFileAuthState(authDir)`, `creds.update` saved every time, `shouldIgnoreJid` returning true for every jid that fails `matchesChat` (and for all jids while no chat is set), `syncFullHistory: false`, `markOnlineOnConnect: false`. `connection.update` drives `LinkStatus` (`qr` rendered to a data URL with the `qrcode` package; `open` -> linked; `close` with `DisconnectReason.loggedOut` -> clear `authDir`, state unlinked; any other close -> state down, reconnect with backoff 2s doubling to 60s). `messages.upsert` passes each message through `matchesChat` again, then `toInbound`, then emits. `sendText` refuses unless linked and a chat is set, and sends only to `phoneJid(digits)`.
- [ ] **Step 4:** Run `npx tsc -p tsconfig.server.json --noEmit`; expect no errors against the Baileys types. Commit.

This transport cannot be run against WhatsApp from the build session. Its live check is the list in `docs/HANDOFF.md`.

### Task 4: Conversation service

**Files:** Create `src/server/conversation.ts`. Test: `tests/conversation.test.ts`.

**Interfaces:** Consumes `Store`, `Translator`, `Transport`, `EventBus`, `shouldSkip`. Produces:

```ts
export class LinkDownError extends Error {}
export class ConversationService {
  constructor(deps: { store: Store; translator: () => Translator | null; transport: Transport; bus: EventBus; now?: () => number });
  start(): void;                                     // subscribes to the transport
  profile(): Profile;                                // from settings, DEFAULT_INSTRUCTIONS when unset
  preview(text: string, tone: Tone): Promise<{ spanish: string; back: string; notes: Note[]; ambiguity: string | null }>;
  send(input: { english: string; spanish: string }): Promise<Message>;
  retry(id: string): Promise<Message>;
  markRead(ids: string[]): Promise<void>;
  settled(): Promise<void>;                          // resolves when in-flight translations finish (tests)
}
```

- [ ] **Step 1:** Write `tests/conversation.test.ts` with `Store(':memory:')`, `FakeTranslator`, `FakeTransport`: `an incoming message is stored and published as translating before the translator resolves, then updated to done with the English`; `a skipped message is stored as skipped with no translator call`; `a message sent from the phone is stored as out, source phone, with no translator call`; **Review Focus 3** `when the translator throws the row is failed, the original is intact, and retry turns it to done`; **Review Focus 3** `preview rejects and send is not called when the translator throws`; **Review Focus 4** `send throws LinkDownError when the link is not linked and leaves no row`; **Review Focus 4** `when the transport's sendText throws, send rejects, no row is stored, and nothing is sent after the link returns`; **Review Focus 5** `the echo of an app-sent message with the same waId creates no second row and no translator call`; **Review Focus 5** `the same incoming waId delivered twice is translated once`; `send with append_english on sends the Spanish, a blank line, then the English`; `markRead forwards only newly read waIds to the transport`; `with no translator configured an incoming message is stored as failed`.
- [ ] **Step 2:** Run; expect failure. Implement. Run; expect pass. Commit.

### Task 5: HTTP API, sign-in and live updates

**Files:** Create `src/server/http/auth.ts`, `src/server/http/app.ts`, `src/server/index.ts`. Test: `tests/http.test.ts`.

**Interfaces:** Consumes everything above. Produces:

```ts
// auth.ts
export function hashPassphrase(p: string): string;               // scrypt, random salt, 'salt:hash' hex
export function verifyPassphrase(p: string, stored: string): boolean;   // timing-safe
export class LoginLimiter { constructor(max: number, windowMs: number); allow(ip: string, now: number): boolean; }
// app.ts
export function buildApp(deps: { config: Config; store: Store; bus: EventBus; transport: Transport; conversation: ConversationService; clientFor: (key: string) => MessagesClient }): FastifyInstance;
```

Routes, all JSON, all but the first three requiring a session cookie `parce_session` (HttpOnly, SameSite=Lax, Secure when the request is HTTPS, 180 days):

| Route | Behaviour |
|---|---|
| `GET /api/state` | `{ configured, authed, hasKey, model, chatSet, link, previewBeforeSend, appendEnglish }` |
| `POST /api/setup` `{ passphrase }` | only while no passphrase exists; minimum 8 characters; signs in |
| `POST /api/login` `{ passphrase }` | 5 attempts per 15 minutes per address, then 429 |
| `POST /api/logout` | deletes the session |
| `PUT /api/settings` | any of `anthropicApiKey`, `model`, `juanNumber`, `previewBeforeSend`, `appendEnglish`, `instructions`, `aboutUs`; `juanNumber` is reduced to digits and applied to the transport |
| `GET /api/models` | `{ models, suggested }` from the provider; 400 when no key; 401 text when the key is rejected |
| `GET /api/messages?before&limit` | newest page, oldest first, limit default 50 max 200 |
| `POST /api/draft` `{ text, tone }` | `{ spanish, back, notes, ambiguity }`; 502 with a reason on translator failure |
| `POST /api/send` `{ english, spanish }` | the stored message; 409 when the link is down; 502 when the send fails |
| `POST /api/messages/:id/retry` | the updated message |
| `POST /api/read` `{ ids }` | 204 |
| `POST /api/link/pairing` `{ phone }` | `{ code }` |
| `POST /api/link/logout` | 204 |
| `GET /api/events` | server-sent events: `message` and `link`; first event is the current link status |

- [ ] **Step 1:** Write `tests/http.test.ts` using `app.inject` with fakes: `every protected route returns 401 without a cookie`; `setup works once and a second setup returns 409`; `setup rejects a 7-character passphrase`; `the sixth wrong login within the window returns 429`; `the API key is never present in any response body`; `PUT settings juanNumber "+57 300 123 4567" calls transport.setChat("573001234567")`; `POST draft returns spanish and back`; `POST send returns 409 when the fake link is down`; `GET messages returns oldest first`.
- [ ] **Step 2:** Run; expect failure. Implement, with `index.ts` choosing `FakeTransport` and `FakeTranslator` when `config.demo` is set, creating `dataDir` with mode 0700, and serving `config.webDir` with an `index.html` fallback for non-API paths. Run; expect pass. Commit.

### Task 6: Web app

**Files:** Create `vite.config.ts`, `src/web/*` as listed. Test: `tests/e2e/smoke.spec.ts`.

The look follows the published mockup: ground `#F3F4F6`, surface `#FFFFFF`, ink `#14181D`, muted `#55606B`, line `#D9DEE3`, control border `#7A8591`, accent `#0F5C63`, on-accent secondary `#CFE6E8`, flag background `#FDF1D7` with text `#7A3E05`. The line in Casey's language is always the strong one; the original sits above the translation. Touch targets are at least 44 px.

Screens, chosen from `GET /api/state`: Setup (not configured, or key, model or Juan's number missing: passphrase, then key, then model picked from `/api/models` with the suggestion preselected, then Juan's number, then the link screen with the code image and a number-code option), Login, Chat.

Chat: bubbles in time order pinned to the bottom, a status line in the header, a banner when the link is `down` or `unlinked`, a retry control on failed translations, and the composer with states draft, preview (Spanish, literal reading, four tone buttons, Edit, Send) and sending. With preview off, Translate is replaced by Send, which previews and sends in one step. Opening the chat marks unread incoming messages read. New messages arrive over `/api/events`.

- [ ] **Step 1:** Write `tests/e2e/smoke.spec.ts` (Playwright, server started with `PARCE_DEMO=1` on a temp data dir): set a passphrase; the chat shows; a message injected from the stand-in Juan appears with `[EN]` text under the original; typing a draft and pressing Translate shows the `[ES:base]` text and the `[BACK]` reading; pressing Warmer changes the text to `[ES:warmer]`; pressing Send adds an outgoing bubble and empties the composer; with the stand-in link set down, Send shows an error and the draft text is still in the composer.
- [ ] **Step 2:** Add a demo-only route `POST /api/demo/juan` `{ text }` and `POST /api/demo/link` `{ state }`, registered only when `config.demo` is set, for this test.
- [ ] **Step 3:** Implement the web app. Run `npm run build`; expect success. Run the e2e test with `--trace off`; expect pass. Commit.

### Task 7: Run on the Mac mini

**Files:** Create `scripts/install-mac.sh`, `scripts/smoke-translate.ts`, `README.md`, `docs/HANDOFF.md`.

- [ ] **Step 1:** `scripts/install-mac.sh`: checks Node 22 or later, runs `npm ci` and `npm run build`, writes `~/Library/LaunchAgents/com.parce.app.plist` (RunAtLoad, KeepAlive, working directory the repository, logs under `~/.parce/logs`), loads it, and prints the address `http://<hostname>.local:8787`.
- [ ] **Step 2:** `scripts/smoke-translate.ts`: reads the key and model from the data directory's store, runs one incoming, one outgoing and one literal reading on invented lines, prints the results, token usage and elapsed time, and exits non-zero on any error.
- [ ] **Step 3:** `docs/HANDOFF.md`: what the installing session does in order (install Node if missing, run the install script, confirm the page loads, walk Casey through setup, run the smoke script, then the WhatsApp check-list: link, receive a message from Juan, send one, send one from the phone and see it appear, restart the program and confirm it reconnects without relinking), and what to report back.
- [ ] **Step 4:** Run `bash -n scripts/install-mac.sh`; expect no output. Run the full test suite; expect pass. Commit and push.
