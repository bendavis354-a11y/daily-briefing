# daily-briefing

A private daily briefing for Ben, assembled from three mailboxes, a calendar and
his iMessages, and published as a password-protected page on GitHub Pages.

## How it fits together

Three moving parts, each with a different job and a different clock.

**The daily run**, 5:00 PM America/New_York. An agent session reads the personal
mailbox through the Gmail connector, runs `src/run-full-briefing.mjs` to scan the
Workspace mailboxes and assemble the facts, writes the analysis, renders the
page, encrypts it, and pushes `index.html` and `state.enc` to the
`claude/briefing` branch. `prompts/routine-prompt.md` is the reference copy of
its instructions — the live prompt lives in the scheduler, so changes here have
to be pasted there.

**The fact refresh**, every ten minutes, in `.github/workflows/refresh-facts.yml`.
Plain deterministic code, no model. It re-scans the Workspace mailboxes and
publishes `status.enc`, a small encrypted snapshot of which threads now await a
reply. The page's "Check for updates" button pulls it, so a briefing opened at
9pm can be told which of its asks he has already dealt with. It commits only
when the facts actually changed.

**The iMessage exporter**, every two hours, on Ben's Mac. See `mac/README.md`.
It publishes `imessages.enc` to the same branch.

The analysis is written once and must hold all evening. The facts underneath it
move on their own.

## Setup the workflow needs

The refresh workflow reads six repository secrets, under Settings → Secrets and
variables → Actions. They are the same values the daily run already uses:

| Secret | What it is |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | the Google OAuth app |
| `GOOGLE_OAUTH_CLIENT_SECRET` | the same app's secret |
| `GMAIL_ACCOUNTS_JSON` | the account list, as raw JSON with no surrounding quotes |
| `GMAIL_REFRESH_TOKEN_HEARTSPRING` | durable Workspace token |
| `GMAIL_REFRESH_TOKEN_BIODYNAMICS` | durable Workspace token |
| `BRIEFING_PASSWORD` | the page password, which is also the encryption key |

The personal account is deliberately absent. Its consumer OAuth token expires
weekly, which is why that mailbox is read through the connector in an agent
session rather than by a scheduled script. Its threads still settle, because
thread status is pooled across mailboxes: a reply sent from a Workspace address
also clears the personal copy of the same thread.

## Running it by hand

```bash
npm install
CONNECTOR_MESSAGES_FILE=/tmp/connector-personal-messages.json node src/run-full-briefing.mjs
node src/merge-narrative.mjs /tmp/brief.json
npm run build
node src/run-state-update.mjs
node src/deploy-briefing.mjs
node src/refresh-status.mjs
```

Tests are plain scripts with no runner:

```bash
node src/continuity.test.mjs
node src/tasks.test.mjs
node src/imessage-store.test.mjs
node src/refresh-status.test.mjs
node src/accounts.test.mjs
```

## What never goes in the repo

It is public. Plaintext briefing content, memory, message bodies and tokens all
stay out; `.gitignore` covers the working files. The three published artefacts
(`index.html`, `state.enc`, `imessages.enc`, `status.enc`) are AES-256-GCM
encrypted under the briefing password.
