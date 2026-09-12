# Mac iMessage exporter

The daily briefing routine runs in an **ephemeral cloud container**. It cannot
read your Mac's Messages database (`~/Library/Messages/chat.db`). The only way
iMessage data reaches the briefing is for *this Mac* to export recent messages
and commit them, encrypted, to the briefing repo — where the cloud routine
reads them during its run.

```
[This Mac]  export-imessages.py  ──encrypt──▶  imessages.enc
                  ▲ launchd, every 2h              │ (git, claude/briefing)
                  │                                ▼
            chat.db (read-only)         [Cloud routine @ 7:00am ET reads it]
```

### Why the repo and not Google Drive

The export used to go to Drive. That path could not work, for two independent
reasons, and it is worth knowing both so it is not rebuilt by accident:

- **Scope.** The cloud side authenticates as a Workspace account holding the
  `drive.file` scope, which only ever sees files *that same OAuth client
  created*. A file uploaded under a different account was invisible to it —
  a **404, not a 403**, which reads like a missing file rather than a
  permissions problem. Sharing the file does not help; `drive.file` cannot
  reach shared files either.
- **Token lifetime.** The upload half authenticated as a consumer
  `@gmail.com` account, whose refresh tokens Google expires after **7 days**.
  Publishing the app does not extend them.

Durable memory hit exactly the same wall and moved into the repo as
`state.enc`. The export now rides the same rails: git is the one transport
both ends already hold durable credentials for. No Google OAuth is involved
in the iMessage path at all any more.

The payload is AES-256-GCM encrypted before it is committed, in the same
container `state.enc` uses, so the repo may stay public.

If this Mac is asleep/off at export time, a plain `cron` job is just skipped —
that is why the data went stale. This uses a **launchd agent** instead, which
catches up shortly after the Mac wakes, and runs every 2 hours so the export
stays under the routine's 6-hour staleness limit during normal use.

## What you need

Three values, in `~/.config/ben-briefing/imessage-export.json`:

| Config key       | What it is                                                      |
|------------------|-----------------------------------------------------------------|
| `github_token`   | a **fine-grained** personal access token, scoped to this repository only, with **Contents: Read and write** |
| `github_repo`    | `owner/repo` of the briefing repository                          |
| `encryption_key` | must equal the cloud's `STATE_ENCRYPTION_KEY`; if that is unset the cloud falls back to `BRIEFING_PASSWORD`, so use that instead |

Optional: `github_branch` (default `claude/briefing`), `window_hours`
(default 48).

Create the token at **GitHub → Settings → Developer settings → Personal access
tokens → Fine-grained tokens**: select only this repository, and under
Repository permissions set **Contents** to *Read and write*. Note the
expiry you choose — when it lapses the export stops, and `mac/diagnose.sh`
section 8 will say so.

`encryption_key` must match the cloud value exactly. The cloud reads
`STATE_ENCRYPTION_KEY` and falls back to `BRIEFING_PASSWORD` when it is not
set — see `statePassword()` in `src/state-store.mjs` — so check which of the
two is actually populated in the routine settings before copying. Today only
`BRIEFING_PASSWORD` is set, which is the password that unlocks the briefing
page.

If the two ends disagree the push still succeeds and the briefing reports a
decryption error rather than a missing export, which is how you tell a key
mismatch from a dead exporter.

> Nothing needs to be pre-installed on the Mac beyond Python 3 and the
> `cryptography` package, which `install.sh` installs for you. The three values
> above live in a config file you create below — not in the system.

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

## Rotating the GitHub token

When the fine-grained token expires or is revoked, the exporter's runs fail
with exit 5 and the briefing stops seeing new texts. Mint a replacement with
the same repository scope and **Contents: Read and write**, then:

```bash
nano ~/.config/ben-briefing/imessage-export.json
bash mac/diagnose.sh
```

Section 8 of the diagnostic confirms the new token can actually write to the
branch, which is the check the old Drive setup never had.

## Grant Full Disk Access (required)

macOS blocks reads of `chat.db` unless the program running the job has Full
Disk Access:

**System Settings → Privacy & Security → Full Disk Access** → add and enable
your `python3` (the installer prints its exact path, e.g. `/usr/bin/python3`).
Add **Terminal** too if you want to run the script by hand.

Without this you'll see a `disk I/O error` / `unable to open database` in the
log — that's the signal Full Disk Access is missing.

## Verify

Run once by hand, writing a local copy you can inspect:

```bash
BEN_IMESSAGE_LOCAL_OUT=/tmp/imessage-export.json python3 mac/export-imessages.py
```

Watch the scheduled runs:

```bash
tail -f ~/Library/Logs/ben-briefing/export.log
```

Confirm the agent is loaded:

```bash
launchctl list | grep com.ben.imessage-export
```

A healthy run logs `Done. Published N messages …`. The next briefing
(7:00am ET) will then report **iMessage export: fresh**.

To confirm the cloud side can see it without waiting for the run, check that
`imessages.enc` on the `claude/briefing` branch has just been updated —
`mac/diagnose.sh` section 8 reports its size and presence.

## Notes & limitations

- **One dependency.** Python 3 standard library plus `cryptography`, for
  AES-256-GCM — macOS ships no AES in the stdlib. `install.sh` installs it, and
  the exporter reinstalls it automatically if a Python upgrade orphans it.
- **Token expiry is announced in advance.** GitHub reports the calling token's
  expiry on every authenticated response. The exporter records it, and the
  briefing raises an action item three weeks out, so the token gets renewed
  before texts stop rather than after.
- **Transient failures retry.** A network blip or a push that collides with the
  daily deploy is retried with backoff. A bad token or missing branch fails
  immediately, since retrying cannot help.
- **Read-only.** The database is opened `mode=ro`; the live Messages app is
  never touched.
- **attributedBody:** On macOS Ventura+ many messages store their text in a
  binary `attributedBody` blob instead of the `text` column. The exporter does
  a best-effort decode of those; most messages come through, but an occasional
  one may show empty text. The plain `text` column is always preferred.
- **Contact names:** Messages' `chat.db` only knows phone numbers / Apple IDs.
  The exporter resolves them against the local Address Book, falling back to
  the raw handle as `sender_name` when there is no match.
- **Privacy:** the config file (with the token and key) and any local export
  copy written by `BEN_IMESSAGE_LOCAL_OUT` live outside the repo and must never
  be committed. Only the **encrypted** `imessages.enc` reaches git;
  `.gitignore` excludes the plaintext forms.

## Troubleshooting a stalled exporter

If the briefing keeps reporting **iMessage export: stale**, `imessages.enc` has
stopped being updated — the exporter on this Mac is failing or not running at
all. The cloud side cannot fix this; diagnose here, on the Mac.

If instead the briefing reports a **decryption error**, the exporter is running
fine and `encryption_key` here disagrees with the cloud's key
(`STATE_ENCRYPTION_KEY`, or `BRIEFING_PASSWORD` when that is unset). Make them
match.

**Quickest path: run the diagnostic with `--fix`.** It performs every check
below, repairs what it safely can, runs the exporter to prove the result, and
prints a verdict. It never prints secrets:

```bash
bash mac/diagnose.sh --fix
```

Without `--fix` it only reports and changes nothing. With it, two recurring
failures repair themselves: an encryption package orphaned by a Python upgrade,
and a scheduled job that is unloaded or pointing at a clone that moved. Anything
needing a decision — a lapsed token, a revoked Full Disk Access grant, a key
mismatch — is named, not guessed at.

This is the one command the briefing itself tells Ben to run when texts stop
arriving, so it is deliberately the only thing he has to remember.

If you cannot find the clone to run it from, that is itself the answer — see
step 1 below.

If you would rather check by hand, note for zsh (the default macOS shell): `#` is **not** a comment character in
an interactive zsh session, so pasting a commented command makes zsh try to
glob the comment and fail with `no matches found`. The commands below are
deliberately comment-free — paste them one at a time.

**1. Locate the clone** (the launchd job stores an absolute path, so a moved or
re-cloned repo silently breaks it):

```bash
find ~ -name export-imessages.py -not -path '*/Library/*' 2>/dev/null
```

**2. Is the agent loaded?** Empty output means it is not:

```bash
launchctl list | grep com.ben.imessage-export
```

**3. What path does the installed job point at?** Compare it to step 1:

```bash
cat ~/Library/LaunchAgents/com.ben.imessage-export.plist
```

**4. What did the last runs say?**

```bash
tail -50 ~/Library/Logs/ben-briefing/export.log
```

**5. Run it by hand**, substituting the real path from step 1:

```bash
python3 ~/daily-briefing/mac/export-imessages.py
```

If step 5 reports `No such file or directory`, you pasted a path that does not
exist — go back to step 1. If it reports nothing at all from `find`, this Mac
has no clone of the repo and the exporter was never installed here; clone the
repo and run `bash mac/install.sh`.

Otherwise the log/exit code tells you which of these it is:

| Symptom in log | Cause | Fix |
|---|---|---|
| Nothing new in the log at all | Agent unloaded (e.g. after migration to a new Mac), or the Mac was off/asleep | `bash mac/install.sh` again |
| `No such file or directory` for the script | The repo clone was moved or renamed — the plist hardcodes absolute paths | Re-run `bash mac/install.sh` from the repo's new location |
| `xcrun: error: invalid active developer path` | A macOS upgrade removed the Command Line Tools that `/usr/bin/python3` needs | `xcode-select --install`, then re-run the installer |
| `disk I/O error` / `unable to open database` (exit 3) | Full Disk Access was revoked — macOS updates and python updates can silently reset this | System Settings → Privacy & Security → Full Disk Access → re-add the `python3` path from the installer output |
| `push of imessages.enc failed: 401/403` (exit 5) | The fine-grained token expired, was revoked, or lacks **Contents: Read and write** on this repository | Mint a replacement and update `~/.config/ben-briefing/imessage-export.json` |
| `push of imessages.enc failed: 404/422` (exit 5) | `github_repo` is wrong, or `github_branch` does not exist | Correct the config; the branch is `claude/briefing` |
| `push of imessages.enc failed: 409` (exit 5) | The branch moved between read and write, three times running | Nothing to do — the next scheduled run retries cleanly |
| `cannot reach <repo>` (exit 5) | Preflight failed: token invalid, expired, or not scoped to the repo | Mint a replacement with Contents: Read and write |
| `the token can read <repo> but cannot write` (exit 5) | The token has Contents: Read only | Regenerate with Contents: Read and write |
| `automatic reinstall failed` (exit 6) | The AES dependency is missing and could not be repaired | `bash mac/diagnose.sh --fix`, or `python3 -m pip install --user cryptography` |

After fixing, verify end-to-end: run the exporter by hand, confirm it logs
`Done. Published N messages…`, and run `bash mac/diagnose.sh` to see
`imessages.enc` present with a current size. The next briefing run should
report **iMessage export: fresh**.

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.ben.imessage-export.plist
rm ~/Library/LaunchAgents/com.ben.imessage-export.plist
```
