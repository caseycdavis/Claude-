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
