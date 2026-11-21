# Parce

A private bilingual messenger that sits on top of one WhatsApp chat. You read and write
English in a web app; the other person keeps using WhatsApp in Spanish. Claude translates
both ways using the recent conversation as context.

- Design: `docs/superpowers/specs/2026-11-19-bilingual-messenger-design.md`
- Build plan: `docs/superpowers/plans/2026-11-21-parce-operational-core.md`
- Installing it on the Mac that runs it: `docs/HANDOFF.md`

## What you should know before using it

The WhatsApp side uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial
library that links to your own account as a second client. That is against WhatsApp's terms
and can get a number banned. The folder holding the link gives full access to the whole
WhatsApp account, so the machine that runs this must be one you trust.

## Run it

Needs Node 22.13 or later.

```bash
npm ci
npm run build
npm start          # http://localhost:8787
```

On macOS, `scripts/install-mac.sh` does the above and registers it to start at login.

Try it with no WhatsApp and no key, using stand-ins that never leave the machine:

```bash
npm run demo
```

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PARCE_PORT` | `8787` | Port the app listens on |
| `PARCE_HOST` | `0.0.0.0` | Address it listens on |
| `PARCE_DATA_DIR` | `~/.parce` | Where the database, the WhatsApp link and logs live |
| `PARCE_DEMO` | unset | `1` uses the stand-in link and translator |

Everything private lives in the data directory and nowhere else: the translation key, the
passphrase hash, the messages and the WhatsApp session. None of it belongs in this repository.

## Tests

```bash
npm test             # unit and API tests
npm run typecheck
npm run test:e2e     # browser test in demo mode; needs a build and Playwright
npm run smoke:translate   # live translator check with the saved key; costs a few cents
```

The WhatsApp link itself has no automated test. It is checked by hand with the list in
`docs/HANDOFF.md`.
