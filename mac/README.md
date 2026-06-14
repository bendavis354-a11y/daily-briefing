# Mac iMessage exporter

The daily briefing routine runs in an **ephemeral cloud container**. It cannot
read your Mac's Messages database (`~/Library/Messages/chat.db`). The only way
iMessage data reaches the briefing is for *this Mac* to export recent messages
to Google Drive, where the cloud routine reads them during its run.

```
[This Mac]  export-imessages.py  ──uploads JSON──▶  Google Drive
                  ▲ launchd, every 2h                      │
                  │                                         ▼
            chat.db (read-only)              [Cloud routine @ 4:30pm ET reads it]
```

If this Mac is asleep/off at export time, a plain `cron` job is just skipped —
that is why the data went stale. This uses a **launchd agent** instead, which
catches up shortly after the Mac wakes, and runs every 2 hours so the export
stays under the routine's 6-hour staleness limit during normal use.

## What you need

The exporter needs four values, the same ones the cloud routine already uses:

| Config key       | Where it comes from                                              |
|------------------|-----------------------------------------------------------------|
| `client_id`      | `GOOGLE_OAUTH_CLIENT_ID` (your Google OAuth app)                |
| `client_secret`  | `GOOGLE_OAUTH_CLIENT_SECRET`                                     |
| `refresh_token`  | the refresh token for **bendavis354@gmail.com** (the account the routine uses for Drive) |
| `drive_file_id`  | `DRIVE_IMESSAGE_FILE_ID` (the Drive file the routine reads)      |

You can copy these from wherever the routine's environment variables are
configured (the Claude Code routine settings). Reusing the
`bendavis354@gmail.com` refresh token is the simplest option — it already has
Drive access, so no new OAuth setup is required.

> Not sure whether the Mac has access yet? You don't need anything
> pre-installed on the Mac. The four values above are all that's required, and
> they live in a config file you create below — not in the system.

## Install (one time)

```bash
cd /path/to/daily-briefing
bash mac/install.sh
```

The installer:

1. Creates a config template at `~/.config/ben-briefing/imessage-export.json`
   (outside the git repo, so secrets are never committed).
2. Installs a launchd agent at
   `~/Library/LaunchAgents/com.ben.imessage-export.plist`.
3. Loads it (runs every 2 hours, plus once immediately).

Then **edit the config** with your real values:

```bash
nano ~/.config/ben-briefing/imessage-export.json
```

## Grant Full Disk Access (required)

macOS blocks reads of `chat.db` unless the program running the job has Full
Disk Access:

**System Settings → Privacy & Security → Full Disk Access** → add and enable
your `python3` (the installer prints its exact path, e.g. `/usr/bin/python3`).
Add **Terminal** too if you want to run the script by hand.

Without this you'll see a `disk I/O error` / `unable to open database` in the
log — that's the signal Full Disk Access is missing.

## Verify

```bash
# Run once by hand and write a local copy you can inspect:
BEN_IMESSAGE_LOCAL_OUT=/tmp/imessage-export.json \
  python3 mac/export-imessages.py

# Watch the scheduled runs:
tail -f ~/Library/Logs/ben-briefing/export.log

# Confirm the agent is loaded:
launchctl list | grep com.ben.imessage-export
```

A healthy run logs `Done. Uploaded N messages to Drive file …`. The next
briefing (4:30pm ET) will then report **iMessage export: fresh**.

## Notes & limitations

- **No pip installs.** Pure Python 3 standard library (`sqlite3`, `urllib`).
- **Read-only.** The database is opened `mode=ro`; the live Messages app is
  never touched.
- **attributedBody:** On macOS Ventura+ many messages store their text in a
  binary `attributedBody` blob instead of the `text` column. The exporter does
  a best-effort decode of those; most messages come through, but an occasional
  one may show empty text. The plain `text` column is always preferred.
- **Contact names:** Messages' `chat.db` only knows phone numbers / Apple IDs,
  not contact names (those live in a separate Address Book database). The
  export uses the handle as `sender_name`.
- **Privacy:** the config file (with secrets) and any local export copy live
  outside the repo and must never be committed. `.gitignore` already excludes
  iMessage exports.

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.ben.imessage-export.plist
rm ~/Library/LaunchAgents/com.ben.imessage-export.plist
```
