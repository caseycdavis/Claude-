# Bilingual messenger for Casey and Juan — design

Date: November 19, 2026
Status: draft, awaiting Casey's approval
Working name: `parce` (my call; rename freely)

## 1. Intent

Casey writes English. Juan writes Medellín Spanish. Today they talk on WhatsApp and Casey
copies messages in and out of a chatbot to translate them, because built-in translators lose
the register, the teasing and the nuance.

This project replaces the copy-and-paste with a private app for Casey that sits on top of his
existing WhatsApp chat with Juan. Casey reads and writes in the app, in English, with the
Spanish beside it. Juan keeps using WhatsApp exactly as he does now and changes nothing.

Text messages are the priority. Voice is wanted but second.

## 2. What Casey decided (November 19, 2026)

- Build a bespoke messenger, not a shortcut or a bot in someone else's app.
- Casey uses the bespoke app; Juan stays in WhatsApp ("option B").
- The WhatsApp side uses an unofficial library that links to Casey's own account as a second
  client. This breaks WhatsApp's terms. Casey has said he is not concerned about a ban.

Everything else in this document is my proposal unless marked as Casey's.

## 3. Goals

1. Every message from Juan appears in Casey's app within a few seconds, showing Juan's
   original Spanish and a natural English translation under it.
2. Casey types English; Juan receives natural Medellín Spanish from Casey's real number, as
   an ordinary WhatsApp message.
3. Translation uses the recent conversation as context, plus standing instructions and a
   glossary that Casey controls, so nicknames, in-jokes and tone carry over.
4. When a line could mean two different things, the app says so separately and does not
   silently pick one.
5. Casey can see what he is about to send in Spanish, with a literal English reading of it,
   before it goes.
6. Voice notes from Juan are transcribed and translated. Casey can dictate English.
7. If the WhatsApp link breaks or the number is banned, the app, its history and its glossary
   survive, and a different way of reaching Juan can be plugged in without rewriting them.

## 4. Non-goals (version 1)

- Juan using the app. The app is single-user. (See section 12 for how this stays cheap to add.)
- Group chats, or more than a short allowlist of one-to-one chats. Version 1 is configured
  for one chat: Juan.
- Sending Spanish audio in Casey's voice or any synthetic voice.
- Voice or video calls.
- Replacing WhatsApp for anyone else Casey talks to.
- Languages other than English and Spanish.
- A native iPhone app. Version 1 is a web app installed to the Home Screen.

## 5. Anti-goals (would make it a failure even if it works)

- A message reaching Juan that Casey did not intend to send, or reaching the wrong chat.
- The program reading, storing or sending to Claude any chat other than the allowlisted one.
- A message that is dropped, delayed for hours, or shown untranslated with no visible sign.
- Translations that soften, embellish, tidy up or "improve" what was said.
- Anything that behaves like bulk or automated messaging.

## 6. Constraints and verified facts

Checked on November 19, 2026. Source in brackets.

**WhatsApp library (Baileys)**
- Current release is `7.0.0-rc14`, last published July 29, 2026, MIT licence, needs Node 20
  or later. It is a release-candidate line with breaking changes from version 6.
  [npm registry]
- It connects as a second WhatsApp client over a direct connection, with no browser, linked
  by QR code or pairing code. [package README]
- Read from the package's own type definitions and source for `7.0.0-rc14`:
  - incoming messages arrive on `messages.upsert`, marked `notify` when received live and
    `append` otherwise;
  - messages Casey sends from his own phone are also delivered and marked `fromMe`;
  - media can be downloaded from a received message, and audio messages are one of the
    media types; voice notes are flagged `ptt`;
  - text can be sent, can quote an earlier message, and a sent message can be edited or
    deleted;
  - read receipts can be sent (`readMessages`);
  - recent history can be requested when linking (`syncFullHistory`, delivered on
    `messaging-history.set`); how much arrives is not documented;
  - version 7 addresses some chats by an opaque "LID" instead of a phone number, with the
    phone-number form carried alongside (`remoteJidAlt`). Juan's chat has to be recognised
    in either form.
- The session keys change as messages flow and must be saved every time; the README warns
  that losing them stops messages reaching the recipient. [package README]
- The project states it is not affiliated with or endorsed by WhatsApp. [package README]

**WhatsApp account behaviour**
- Linked devices are logged out if the main phone is inactive for more than 14 days.
  [secondary press coverage of WhatsApp's help pages; not read first-hand]
- Whoever holds the session files has full access to Casey's whole WhatsApp account.
  [follows from how linking works]

**Translation and speech**
- Claude's Messages API accepts text, images and documents. Its reference lists no audio
  input, so voice needs a separate speech-to-text step. [Claude API reference, first 100,000
  characters of the page read]
- Claude can be made to return a fixed structure (translation, notes, ambiguity) and can
  cache the unchanging part of a prompt. [Claude API reference material]

**iPhone notifications**
- A web app can send notifications on iPhone only after it is added to the Home Screen, on
  iOS 16.4 or later. [secondary sources; WebKit's own page was unreachable]

**What this build session can and cannot test**
- This session cannot reach WhatsApp or OpenAI (both blocked by its network policy) and has
  no Anthropic key. [tested]
- So: the WhatsApp link is built against a stand-in here and proven on Casey's host with his
  phone. Live translation tests need an Anthropic key, requested through the secure
  credential form, never pasted into chat.

## 7. Approaches considered

| Approach | What it is | Why it was or was not chosen |
|---|---|---|
| A. Two-person web app | Both open a private web app | No account risk, both see side-by-side. Depends on Juan opening it. Not chosen. |
| **B. Casey in the app, Juan in WhatsApp** | App for Casey; unofficial link to his WhatsApp account | **Chosen by Casey.** Asks nothing of Juan. Costs: an always-on machine, breakage when WhatsApp changes, full-account exposure on that machine, ban risk. |
| Telegram group with a translator bot | Bot replies to each message with a translation | Smallest build, but translation is a second bubble and Juan must install Telegram. Not chosen. |
| WhatsApp Business relay number | Both text a business number that relays translations | 24-hour reply window, template rules, unclear standing under Meta's AI-provider policy. Not chosen. |

## 8. How it works

One program runs all day on one machine. It has four parts.

```
 Juan's WhatsApp  <──>  [ WhatsApp link ]  <──>  [ Conversation store ]  <──>  [ Casey's app ]
                                                        │
                                                [ Translator (Claude) ]
```

**WhatsApp link.** Holds the connection to Casey's account. Receives messages, sends
messages, reports whether it is connected. It is the only part that knows WhatsApp exists.
It discards, without storing, everything that is not from the allowlisted chat.

**Conversation store.** One database file on disk: messages (original text, translation,
notes, status, timestamps), the glossary, settings, drafts.

**Translator.** Given a message and its direction, returns the translation plus optional
notes. Knows nothing about WhatsApp or the screen.

**Casey's app.** A web app served by the same program: sign-in, the chat screen, a composer,
settings, and a "link WhatsApp" screen that shows the QR code or pairing code so no terminal
is needed.

### Incoming message

1. Juan sends a message. It appears in the app immediately, in Spanish.
2. The translation fills in under it a moment later.
3. Casey gets a notification with the English text (a setting can hide the text).
4. When Casey opens the message in the app, WhatsApp is told it was read, so Juan's ticks
   behave as they do today.

### Outgoing message

1. Casey types English and taps Translate.
2. The composer shows the Spanish that will be sent and, under it, a literal English reading
   of that Spanish. The literal reading is produced by a separate request that is shown only
   the Spanish, not Casey's English, so it is an independent check and not an echo.
3. Casey can send it, edit the Spanish by hand, or tap a tone chip (warmer, firmer, more
   playful, shorter) to get a new version.
4. On Send, the Spanish goes to Juan. The app keeps Casey's English with it.

A setting switches to "send immediately" for people who trust it. Preview is the default
because a message sent in Casey's name cannot be reliably unsent.

### Messages Casey sends from WhatsApp itself

They show up in the app as sent, unchanged. Nothing is translated or altered.

### What the screen looks like

```
┌──────────────────────────────────────┐
│ Juan                    ● linked     │
├──────────────────────────────────────┤
│  Tranquilo parce, acá te espero      │
│  No rush, man, I'll wait here        │
│  ⓘ parce = buddy                     │
│                                      │
│              What do you want to eat?│
│              ¿Vos qué querés comer?  │
│                                  ✓✓  │
├──────────────────────────────────────┤
│ I might be late, wait for me         │
│ ─────────────────────────────────    │
│ Puede que llegue tarde, esperame     │
│ "It may be that I arrive late,       │
│  wait for me"                        │
│ [warmer] [firmer] [playful] [shorter]│
│                     [Edit]  [Send ➤] │
└──────────────────────────────────────┘
```

Tapping any bubble offers: Explain this, Retranslate, Add a term to the glossary.

## 9. Translation behaviour

- **Standing instructions**, editable in settings. Seeded with: English to natural Medellín
  Spanish, using voseo where it sounds right; Spanish to natural English; keep warmth,
  teasing, uncertainty and firmness; add nothing and soften nothing; if a phrase could
  mean two different things, flag that separately and do not pick one.
- **About us**: a short free-text note Casey writes (who the two of them are to each other,
  how they talk). Sent with every request.
- **Glossary**: terms, nicknames and in-jokes with the meaning Casey wants. Casey edits it.
  Claude may suggest an entry; nothing is added without Casey's tap.
- **Context**: the most recent messages of the thread, in their original language, with who
  said each. Translations of old messages are not needed for context.
- **Result shape**: translation; optional notes on slang or cultural reference; optional
  ambiguity with the two readings; for outgoing, the literal English reading.
- **Skips**: emoji-only messages, bare links and messages already in the reader's language
  are shown as they are.
- **Model**: Claude, Opus tier, set by configuration. A settings switch lets Casey try a
  cheaper tier and judge the Spanish himself.
- **Cost, rough estimate to be measured in phase 1**: about 1 to 3 US cents per message on
  the Opus tier at prices cached November 3, 2026, lower in bursts thanks to prompt caching,
  and several times lower on cheaper tiers. At 50 messages a day that is roughly $15 to $45
  a month.
- **Speed, to be measured in phase 1**: expect the translation a second or more after the
  original appears. The original is never held back waiting for it.

### Judging the translation

Casey cannot check the Spanish by reading it, and no fluent Medellín reader is assumed. So:

- Phase 1 builds a fixed sample set from real lines Casey supplies: messages where earlier
  translators got it wrong, with what was meant. Every change to the instructions or the
  model is run against that set and the before and after are shown side by side.
- The independent literal reading (section 8) is Casey's day-to-day check on outgoing text.
- Juan's reactions are the final test. This is a stated limit, not a solved problem: a
  mistranslation that reads plausibly in the literal reading can still get through.
- Real chat lines used for this stay out of the repository.

## 10. Voice and other content

- **Voice notes from Juan**: audio is downloaded and playable in the app; a transcript in
  Spanish and its English translation appear under it. Needs a speech-to-text key. The
  provider sits behind one small interface; OpenAI's transcription API is the default.
  Without a key, voice notes show as playable audio with no transcript.
- **Casey dictating**: hold to speak English; the text lands in the composer and goes through
  the normal preview. It is sent as text.
- **Photos**: shown in the app; captions are translated.
- **Everything else** (video, documents, stickers, locations, polls, calls): one line saying
  what arrived and to open WhatsApp for it.
- **Reactions from Juan**: shown. Sending reactions from the app is not in version 1.
- **Edits and deletions by Juan**: an edit replaces the text and is retranslated; a deletion
  is shown as deleted.
- **History**: on first link the program asks for recent history and imports whatever
  arrives for Juan's chat, untranslated. Old messages are translated only when tapped.

## 11. Safety, privacy and failure

- **Sign-in**: one user. A passphrase set at install, a long-lived session on Casey's
  devices, attempts rate-limited. Everything is behind sign-in and HTTPS.
- **Allowlist**: Juan's chat only, matched in both phone-number and LID form. Messages from
  any other chat are discarded in memory and never written or sent anywhere.
- **Sending guard**: the program can send only to an allowlisted chat. There is no code path
  that sends to anyone else.
- **Session files**: stored on the machine's persistent disk, readable only by the program.
  An Unlink button logs the program out of WhatsApp; Casey can also remove it under Linked
  devices on his phone.
- **Translation failure**: the original stays visible with "translation failed, retry".
  Outgoing: the draft stays in the composer; nothing is sent untranslated unless Casey
  chooses "send as written".
- **WhatsApp link down**: a banner says since when, and Casey is notified. Outgoing messages
  are not queued; the draft is kept and Casey sends when the link is back.
- **Logged out by WhatsApp**: the app says so and shows the link screen again.
- **WhatsApp stays the safety net.** WhatsApp on Casey's phone keeps working throughout, so
  every message from Juan notifies twice: WhatsApp in Spanish, the app in English. Casey
  will probably mute one. If he mutes WhatsApp and the machine itself dies, the app cannot
  announce its own death, so an outside check pings the program every few minutes and
  alerts Casey if it stops answering. That check ships with notifications in phase 4.
- **What leaves the machine**: Juan's and Casey's messages for this one chat go to Anthropic
  for translation, and voice audio goes to the speech-to-text provider. Nothing else.

## 12. Keeping option A cheap

The WhatsApp link is one implementation of a small "transport" contract: deliver incoming
message, send outgoing message, report status. Version 1 ships two implementations: WhatsApp,
and a stand-in used for tests and for trying the app without WhatsApp.

A later "Juan uses the app too" mode would be a third implementation plus a second sign-in.
It is not built in version 1. The store, translator and chat screen would not change.

## 13. Build order

Each phase leaves something usable.

1. **App and translator.** Chat screen, composer with preview and literal reading, store,
   sign-in, translator, and the stand-in transport playing Juan. Installed on the real
   machine from the start, so Casey uses it on his phone and not only in the build session.
   Sample set built from Casey's lines. Measure cost and speed. Needs the Anthropic key.
2. **WhatsApp link.** Link screen, receive and send for Juan's chat, allowlist, reconnect,
   status banner, read receipts, history import. Packaged to run on Casey's machine. First
   point at which Casey uses it for real.
3. **Quality layer.** Glossary, notes, ambiguity flags, tone chips, Explain, model switch.
4. **Notifications.** Home Screen install, push notifications, and the outside check that
   alerts Casey if the machine stops answering.
5. **Voice and photos.** Voice notes in, dictation, photos and captions.
6. **Hardening.** Run-book for link loss, updates to the WhatsApp library, backup of the
   database.

## 14. How it gets made (my calls)

- One TypeScript program on Node 22, one database file (SQLite), web app in React, packaged
  as a single container image.
- Baileys pinned to the exact version `7.0.0-rc14`; upgrades are deliberate.
- Anthropic's official TypeScript SDK for translation.
- Tests run against the stand-in transport. The WhatsApp link gets a short manual check-list
  Casey runs with his phone, because it cannot be exercised from the build session.
- Casey is not expected to use a terminal. Setup is done by clicking through a hosting
  provider's website with written steps; linking WhatsApp happens inside the app. Updates,
  including a new version of the WhatsApp library, arrive by the machine rebuilding itself
  from this repository when a change is pushed.

## 15. Left to the builder

- Screen styling and component structure.
- Database schema details and migration approach.
- Exact prompt wording, provided the behaviour in section 9 holds.
- How many recent messages form the context window, tuned in phase 1 against cost.
- Reconnect timing.
- Whether replying to a specific message from the app makes version 1 (small; nice to have).

## 16. Open for Casey

1. **Where it runs.** It needs a machine that is on all day, with a disk that survives
   restarts and a secure address Casey's phone can reach. This choice decides how the secure
   address is obtained, how updates arrive and who maintains the machine.
   - *Rented (my recommendation).* A small hosted machine that rebuilds itself from this
     repository. Public secure address included, no terminal, nothing at home to keep
     running. Roughly $5 a month: Fly.io's price list effective October 1, 2026 shows $4.39
     a month for its 512 MB machine, with disk at about $0.15 per GB per month reported by
     third parties. The specific provider is picked in the plan after checking it against
     the needs above. The session files sit on a machine on the public internet, protected
     by the sign-in.
   - *At home.* A computer that never sleeps, reached through a private tunnel. No monthly
     fee and the session files never leave the house, but Casey keeps it running and
     updates take a manual step.
2. **Sample lines.** Ten to twenty real messages, his and Casey's, where translators got it
   wrong, each with what was meant. Given to the build session directly, not committed.
3. **Keys.** An Anthropic API key is required from phase 1. A speech-to-text key is needed
   only for voice (phase 5). Both entered through the secure credential form.
