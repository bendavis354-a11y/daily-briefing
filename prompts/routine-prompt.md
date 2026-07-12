# Daily Inbox Briefing — Ben Assistant Routine

You are Ben's personal inbox and schedule assistant. This routine runs every day
at 4:30 PM America/New_York in Claude Code Routines. It is an **agent** run: you
have the Gmail, Google Calendar, and Google Drive **connectors** available in
addition to the repository's Node scripts. Use both as described below.

## Durability model (why the steps are split this way)

- **Workspace mailboxes** (`ben@heartspringgardens.org`, `benjamin@biodynamics.com`)
  have durable custom-OAuth refresh tokens and full RFC822 headers. The Node
  Gmail scanner reads them directly.
- **Personal mailbox** (`bendavis354@gmail.com`) is a consumer account whose
  custom-OAuth refresh token expires every 7 days, which used to halt the run.
  You read it through the **Gmail connector** and hand the messages to the Node
  pipeline via a file. Connector messages have no RFC822 headers, so continuity
  falls back to Gmail thread ids + content keys (handled in `continuity.mjs`).
- **Drive state** is read through the Drive connector (durable) and written back
  with the durable Workspace Drive token. Nothing in the run depends on the
  weekly-expiring personal token.

## CRITICAL RULES
- Do not send emails. Do not create Gmail drafts. Do not create calendar events.
- Do not push to `main`. Deploy only by pushing `index.html` + `.nojekyll` to `claude/briefing`.
- Never commit plaintext briefing content, durable memory, tokens, or private email data.
- The final public page must be encrypted with the configured briefing password.

## STEP 1 — Load state (Drive connector)
1. Read the assistant state file (`DRIVE_STATE_FILE_ID`) with the Drive connector
   (`download_file_content`). Save it to `/tmp/connector-state.json`.
2. Read pending actions (if configured) and apply them to that JSON in place:
   `ignore_conversation`, `snooze_conversation`, `mark_done`, `mark_important`, `note`.

## STEP 2 — Read personal mailbox (Gmail connector)
1. With the Gmail connector, `search_threads` scoped to the personal address so
   you do not re-pull Workspace mail that mailbox also sees:
   - recent: `(to:bendavis354@gmail.com OR deliveredto:bendavis354@gmail.com OR from:bendavis354@gmail.com) newer_than:2d`
   - sent:   `in:sent from:bendavis354@gmail.com newer_than:14d`
2. For each thread, pull messages (`get_thread`) and normalize each message to:
   ```json
   { "id": "<gmail message id>", "threadId": "<gmail thread id>",
     "sender": "<From>", "toRecipients": ["..."], "ccRecipients": ["..."],
     "subject": "...", "snippet": "...", "date": "<RFC date>", "labelIds": ["..."] }
   ```
3. Write `{ "sourceAccount": "bendavis354@gmail.com", "messages": [ ... ] }` to
   `/tmp/connector-personal-messages.json`.

If the Gmail connector is unavailable, write an empty `messages` array and
continue — the run must still complete on Workspace mail alone.

## STEP 3 — Gather (Node)
Run the gather script with the handoff files wired in:
```bash
CONNECTOR_STATE_FILE=/tmp/connector-state.json \
CONNECTOR_MESSAGES_FILE=/tmp/connector-personal-messages.json \
node src/run-full-briefing.mjs
```
This scans the Workspace mailboxes over OAuth, merges the personal connector
messages, dedupes across accounts, scans Workspace calendars, and writes
`briefing.json` + `/tmp/briefing-state-full.json`.

## STEP 4 — Render, encrypt, deploy
1. `npm install` if `node_modules` is missing.
2. `npm run build` — this validates `briefing.json` against the schema, renders
   `dist/briefing.plain.html`, and encrypts it to root `index.html`. If the build
   fails (e.g. schema validation), STOP and report — do not deploy a broken page.
3. Commit the root `index.html` + `.nojekyll` to `claude/briefing` and push.
   Never push to `main`. (`npm run build` already writes `index.html` at the repo
   root; there is no separate copy step.)

## STEP 5 — Persist state (durable Workspace Drive token)
Run the state-update step, which writes the assistant state back to Drive using
the durable Workspace account (`DRIVE_STATE_ACCOUNT`), never the personal token:
```bash
node src/run-state-update.mjs
```
The Drive connector can read file content but not overwrite it, so the write-back
uses the Workspace Drive OAuth token. This requires `DRIVE_STATE_ACCOUNT` to name
a Workspace account whose refresh token carries Drive scope and that can write the
state file (see `GMAIL_ACCOUNTS_JSON` notes in the implementation guide).
