# Installing Parce on the Mac that runs it

This is for the Claude Code session running on the always-on Mac. The code was written and
tested in a cloud session that could not reach WhatsApp and had no translation key, so two
parts have never run for real. Your job is to install it, run those two parts live, fix
what breaks, and tell the owner plainly what worked.

Read `README.md` first. The design is in `docs/superpowers/specs/`, the build plan in
`docs/superpowers/plans/`.

## What is proven and what is not

| Part | State |
|---|---|
| Store, conversation logic, HTTP API, sign-in | Unit and API tests pass (`npm test`) |
| Web app | Browser test passes in demo mode (`npm run test:e2e`) |
| Translator (`src/server/translator/claude.ts`) | Tested against a stand-in client only. **Never called the real API.** |
| WhatsApp link (`src/server/transport/whatsapp.ts`) | Type-checked against Baileys `7.0.0-rc14` only. **Never connected.** |
| `scripts/install-mac.sh` | Syntax-checked only. **Never run on macOS.** |

## Rules

- Never print, log, commit or paste the translation key, the passphrase, the contents of
  `~/.parce`, or real message text. Use invented lines in tests and in what you report.
- Work on the branch you were given. Fix bugs test-first where a test is possible, commit,
  and push.
- The owner does not use a terminal. Do the commands yourself and give them only steps they
  do in a browser or on their phone.
- Do not send any WhatsApp message yourself. The owner sends the test messages from the app.

## Steps

1. **Node.** Check `node -v` is 22.13 or later. If Node is missing or older, install the
   current Node 22 release (the installer from nodejs.org, or Homebrew if it is already on
   the machine).
2. **Install.** Run `bash scripts/install-mac.sh`. It builds the app, registers it to start
   at login, and prints the address. If it fails, read the output, fix the script, and
   commit the fix.
3. **Confirm it serves.** `curl -s http://127.0.0.1:8787/api/state` should print
   `{"configured":false,"authed":false,"demo":false}`. Run `npm test` and report the count.
4. **Owner: setup screen.** Give the owner the address from the same network
   (`http://<name>.local:8787`). In their browser they choose a passphrase, paste the
   Anthropic API key, and enter Juan's number with country code. Saving the key checks it
   against the provider and picks a model.
5. **Translator, live.** Run `npm run smoke:translate`. It makes three real calls and prints
   results, timings and token counts. Report the timings and whether any call says
   `plain request` (that means the structured form was rejected and the fallback was used;
   find out why from the provider's error and fix the request in `claude.ts`).
6. **Owner: link WhatsApp.** On the setup screen, card 4, they press "Show linking code"
   and scan it with WhatsApp on their phone (Settings, Linked Devices, Link a Device).
   Watch `~/.parce/logs/parce.log`. The link should move to "Linked".
7. **WhatsApp check-list.** With the owner, in this order:
   1. Juan (or the owner from a second phone on Juan's number) sends a text. It appears in
      the app with a translation under it.
   2. The owner sends a message from the app. It arrives in WhatsApp in Spanish, and shows
      once in the app, with both lines.
   3. The owner sends a message from WhatsApp on their phone. It appears once in the app,
      marked "Sent from WhatsApp".
   4. A message arrives from some other chat. Nothing about it appears in the app or in
      `parce.db`.
   5. Restart the program (`launchctl kickstart -k gui/$(id -u)/com.parce.app`). It
      reconnects without a new code, and a message sent meanwhile shows up.
   6. Juan sends a voice note or a photo. The app shows a one-line placeholder.

## Things most likely to need fixing

- **Juan's messages do not appear.** Version 7 of Baileys may address the chat by an opaque
  LID instead of the phone number. `matchesChat` in `transport/wa-map.ts` accepts either
  form when the other rides alongside (`remoteJidAlt`), and the link asks the library for
  the LID on connect. If messages still do not match, log only the *shape* of the incoming
  key (which fields are set and their suffixes, never the digits) and adjust.
- **The linking code never appears, or linking loops.** Check the close codes in
  `onConnection` against what the library reports. A `restartRequired` close straight after
  scanning is normal and is handled by reconnecting.
- **Sent messages show twice.** The app holds "from me" messages that arrive during a send
  and drops the echo by WhatsApp message id. If the echo carries a different id, that
  assumption is wrong; see `ConversationService.send`.
- **Read receipts do not register.** `markRead` rebuilds message keys from memory. After a
  restart it falls back to the chat address, which may not be enough.
- **Translation is slow.** No effort level is set, so the model's default applies. Measure
  with the smoke script before changing anything, then try a lower effort in
  `output_config` in `claude.ts`.
- **A sent message never arrives but shows as sent.** "Sent" means WhatsApp's server took
  the message. A refusal that comes back afterwards marks the bubble "Not delivered"
  (`messages.update` with an error status). A message lost on a connection that had quietly
  died is not detected. Watch which `messages.update` statuses really arrive for sent
  messages; if a server acknowledgement is reliable, add a "not confirmed" state for sends
  that never get one.
- **Number-code linking fails.** The app only asks for a number code after the first QR
  code has arrived. If it still ends unlinked, link by QR instead and note what the log said.

## Known gaps, left on purpose

- The library decrypts messages from every chat before this program's filter drops the
  ones that are not Juan's. Nothing from other chats is stored, shown, logged or sent to
  the translator. The library's own `shouldIgnoreJid` option was not used because it answers
  every ignored message with an error receipt, which is an unusual thing for an account to do.
- Sending has no duplicate protection: if the app's request succeeds but its answer is lost,
  pressing Send again sends twice.
- Whoever opens the app first after install chooses the passphrase. Do step 4 straight
  after step 3.
- On the home network the app is plain HTTP, so the passphrase and messages cross the Wi-Fi
  unencrypted until the private tunnel is set up.

## After it works

Tell the owner:

- the address that works from their MacBook on the home network;
- the translator timings and rough tokens per message from the smoke script;
- each check-list item as passed, failed (with what you saw), or not run;
- anything you changed, by commit.

Two things are deliberately not done yet and need the owner's decision before you start
them: reaching the app from outside the home network (a private tunnel, plus the Home
Screen app and notifications), and automatic login on this Mac so the program comes back by
itself after a power cut. The program starts when this macOS user logs in, not before.

## Decisions taken during the build

Each line is what was decided, why, and what it costs if it turns out wrong.

- **Setup.** no separate git worktree — the session already works on the dedicated branch claude/ai-bilingual-messenger-s5d5hg in an isolated cloud container — cost if wrong: none, main is untouched.
- **Setup.** plan-review and execution-method question skipped — Casey said on 2026-11-21 to treat the design as fine and focus on getting it operational; inline execution chosen for cost — cost if wrong: he would have preferred per-task review.
- **Task 1.** briefs not re-read from disk — the plan was written in this same context minutes ago and is verbatim above — cost if wrong: a drifted detail, caught by the tests the plan names.
- **Task 1.** added tsconfig.web.json, test:e2e and typecheck scripts, and an engines floor of 22.13 (first release where node:sqlite needs no flag) — the plan's file list was short — cost if wrong: none.
- **Task 2.** MessagesClient gained messages.create, and the translator retries a rejected structured request once as plain JSON — the structured request cannot be run live from the build session, so a 400 on the Mac mini would otherwise block all translation — cost if wrong: one extra failing call when the 400 has another cause.
- **Task 2.** shouldSkip also skips text with no letters or digits at all ("?", "...") — nothing to translate — cost if wrong: a punctuation-only message shows without a translation line.
- **Task 3.** shouldIgnoreJid drops only non-user addresses (groups, broadcasts, channels); one-to-one chats are filtered per message by matchesChat — the plan's "ignore every jid that fails matchesChat" cannot see the alternate address, so a chat addressed by LID before the LID is learned would vanish (Review Focus 2) — cost if wrong: other one-to-one messages are decrypted in memory before being dropped; they are still never stored or forwarded.
- **Task 3.** start() also serves as "show a new linking code", and an unscanned code is refreshed at most 3 times before the link waits to be asked — avoids fetching codes forever while unlinked — cost if wrong: Casey taps "show code" again.
- **Task 3.** read receipts use full message keys remembered in memory (last 500), falling back to the chat address after a restart — the store keeps only WhatsApp's message id — cost if wrong: a receipt after a restart may not register and Juan's ticks stay grey for that message.
- **Task 3.** edits and deletions by Juan are ignored for now (protocol messages map to nothing) — spec section 10 covers them and they belong with the later content plan — cost if wrong: an edited message keeps showing its first wording.
- **Task 4.** send() takes an optional `back` so the literal reading shown in the preview is stored with the sent message — the plan's signature had only english and spanish — cost if wrong: none, the field is optional.
- **Task 4.** Store.recentContext gained an optional `before` time, used by retry so a message is not part of its own context — cost if wrong: none.
- **Task 4.** "from me" messages arriving while a send is in flight are held until that send has stored its row — WhatsApp can echo a sent message before the send call returns, which would otherwise create a second, Spanish-only bubble — cost if wrong: a phone-typed message appears a moment later than it could.
- **Task 4.** retry() rethrows when the translation fails again (row stays failed) so the screen can show the reason, e.g. a rejected key — cost if wrong: none.
- **Task 5.** added POST /api/link/start (calls transport.start) — the link screen needs a way to ask for a fresh code after the transport stops refreshing — cost if wrong: none.
- **Task 5.** state-changing API requests carrying an Origin that is not this app's own host are refused with 403 — cheap protection against another site driving the API with Casey's cookie — cost if wrong: a reverse proxy that rewrites Host without Origin would be blocked; fix is to trust that proxy's host.
- **Task 5.** saving a key checks it by listing models, refuses a rejected key, and picks the model when none is chosen — setup needs immediate feedback on a bad key — cost if wrong: the key cannot be saved while the machine is offline.
- **Task 5.** /api/state returns only configured/authed/demo before sign-in — the plan's field list would have told an unauthenticated visitor the link state — cost if wrong: none.
- **Task 5.** unknown /api paths return 401 before sign-in and 404 after — does not reveal which paths exist — cost if wrong: none.
- **Task 5.** demo routes built here in src/server/http/demo.ts instead of Task 6 step 2 — index.ts needed them to compile — cost if wrong: none.
- **Task 6.** setup and settings are one screen (the same four cards plus the sending switches); the chat opens once key, model and number are saved, and linking can be finished from the chat banner — fewer screens to build and the same cards are needed later anyway — cost if wrong: first-time setup feels less guided than a step-by-step wizard.
- **Task 6.** editing the Spanish by hand in the preview is not built; Edit returns to the English draft (spec section 8, outgoing step 3) — a hand edit makes the literal reading stale and needs its own re-check call — cost if wrong: Casey cannot fix one word of the Spanish himself; he rewords the English or uses a tone button.
- **Task 6.** "Send as written, untranslated" is offered only after a translation has failed — keeps the untranslated path a deliberate choice (Global Constraints) — cost if wrong: no way to send raw text while the translator works.
- **Task 6.** Enter runs the main button (Translate, or Send with preview off); Shift+Enter makes a new line — cost if wrong: on a phone keyboard Return translates instead of adding a line; with preview on nothing is sent by it.
- **Task 6.** demo mode shows a strip to type as Juan and to break the link — lets Casey try the app with no WhatsApp and gives the browser test its controls — cost if wrong: none, it is absent outside demo mode.
- **Task 7.** the live translator check lives at src/server/scripts/smoke-translate.ts (plan said scripts/) so it compiles with the server build and runs with `npm run smoke:translate` — cost if wrong: none.
- **Task 7.** the program is registered as a per-user LaunchAgent, which starts at login, not at boot — a system-wide daemon would need administrator rights and a different home for the data — cost if wrong: after a power cut the app stays down until the Mac's user is logged in; HANDOFF.md flags automatic login as the owner's decision.
- **Final.** shouldIgnoreJid removed altogether; all filtering is per message in ChatFilter — the library answers every ignored message with an error receipt (messages-recv.js processNode), an unusual pattern for a personal account with many groups — cost if wrong: group traffic is decrypted in memory before being dropped, a little more work for the Mac.
- **Final.** a message lost on a half-dead connection still shows as sent — detecting it needs server acknowledgements whose behaviour cannot be observed from the build session; a false "not delivered" on every message would be worse — cost if wrong: Casey believes a message went out that did not; HANDOFF.md asks the installing session to verify and add a "not confirmed" state.
- **Final.** plain HTTP on the home network stands until the tunnel step — stated starting point of the plan — cost if wrong: someone on the home Wi-Fi could read the passphrase and messages in transit.
- **Final.** effect of the library's receipts for other chats, and what WhatsApp puts in the alternate address on own-phone messages — cannot be judged without a live account; listed in HANDOFF.md — cost if wrong: Juan's messages or Casey's phone-sent messages fail to match and do not appear.
- **Final.** non-atomic session writes, LaunchAgent at login, translation quality, passphrase change, log rotation — outside this plan; LaunchAgent and automatic login are already flagged for the owner — cost if wrong: none new.
- **Final.** superpowers:finishing-a-development-branch not run — the work continues from this same pushed branch on the Mac mini and Casey has not asked for a pull request — cost if wrong: none.

## Small things noted and not fixed

- /api/send has no idempotency key, so a lost response can lead to a duplicate send.
- /api/setup is first-come on the home network until Casey's first visit.
