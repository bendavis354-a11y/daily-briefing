#!/bin/bash
#
# Diagnose a stalled iMessage exporter. Read-only: this script changes nothing,
# it only reports. Run it on the Mac that is supposed to be exporting:
#
#   bash mac/diagnose.sh
#
# Secrets are never printed — the config check reports only which keys are
# present, never their values.
#
set -o pipefail

LABEL="com.ben.imessage-export"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONFIG_FILE="$HOME/.config/ben-briefing/imessage-export.json"
LOG_FILE="$HOME/Library/Logs/ben-briefing/export.log"
CHAT_DB="$HOME/Library/Messages/chat.db"
PYTHON_BIN="$(command -v python3 || true)"

problem_count=0
problem_list=""
add_problem() {
  problem_count=$((problem_count + 1))
  problem_list="${problem_list}${problem_count}. $1
"
}
note() { echo "    $*"; }
section() { echo; echo "==> $*"; }

echo "==> iMessage exporter diagnostics — $(date)"
note "host: $(hostname)"
note "python3: ${PYTHON_BIN:-NOT FOUND}"

# 1. Is the repo even on this Mac?
section "1. Repo clone"
clones="$(find "$HOME" -name export-imessages.py -not -path '*/Library/*' 2>/dev/null)"
if [[ -z "$clones" ]]; then
  note "NOT FOUND — no clone of daily-briefing on this Mac."
  add_problem "No clone of the repo on this Mac. Clone it, then run: bash mac/install.sh"
else
  while IFS= read -r c; do note "found: $c"; done <<< "$clones"
fi

# 2. Is the launchd agent loaded?
section "2. launchd agent"
if launchctl list 2>/dev/null | grep -q "$LABEL"; then
  note "loaded: $(launchctl list | grep "$LABEL")"
  note "(columns: PID ExitCode Label — a non-zero ExitCode is the last run's failure)"
  last_exit="$(launchctl list | grep "$LABEL" | awk '{print $2}')"
  case "$last_exit" in
    0|-) ;;
    3) add_problem "Agent's last run exited 3: cannot read chat.db — Full Disk Access missing." ;;
    4) add_problem "Agent's last run exited 4: Google OAuth refresh failed — token expired or revoked." ;;
    5) add_problem "Agent's last run exited 5: Drive upload failed — check drive_file_id." ;;
    2) add_problem "Agent's last run exited 2: config missing or incomplete at $CONFIG_FILE" ;;
    *) add_problem "Agent's last run exited $last_exit — see the log below." ;;
  esac
else
  note "NOT LOADED — launchctl does not know about $LABEL."
  add_problem "launchd agent is not loaded. Run: bash mac/install.sh"
fi

# 3. Does the installed job point at a script that still exists?
section "3. Installed job path"
if [[ -f "$PLIST" ]]; then
  note "plist: $PLIST"
  job_script="$(grep -A1 'export-imessages.py' "$PLIST" 2>/dev/null | grep -o '/[^<]*export-imessages\.py' | head -1)"
  if [[ -n "$job_script" ]]; then
    note "points at: $job_script"
    if [[ -f "$job_script" ]]; then
      note "that file EXISTS."
    else
      note "that file IS MISSING — the clone was moved, renamed, or deleted."
      add_problem "The launchd job points at $job_script which no longer exists. Re-run: bash mac/install.sh from the clone's current location."
    fi
  else
    note "could not parse a script path out of the plist."
  fi
else
  note "NO PLIST at $PLIST — the exporter was never installed on this Mac (or was uninstalled)."
  add_problem "No launchd plist installed. Run: bash mac/install.sh"
fi

# 4. What does the log say?
section "4. Export log"
if [[ -f "$LOG_FILE" ]]; then
  note "log: $LOG_FILE"
  note "last modified: $(date -r "$LOG_FILE" 2>/dev/null)"
  last_ok="$(grep 'Done. Uploaded' "$LOG_FILE" 2>/dev/null | tail -1)"
  if [[ -n "$last_ok" ]]; then
    note "last successful upload: $last_ok"
  else
    note "no successful upload recorded in this log."
  fi
  echo
  note "--- last 25 lines ---"
  tail -25 "$LOG_FILE" | sed 's/^/    /'
else
  note "NO LOG at $LOG_FILE — the job has never produced output on this Mac."
fi

# 5. Config present and complete? (presence only — never values)
section "5. Config"
if [[ -f "$CONFIG_FILE" ]]; then
  note "config: $CONFIG_FILE ($(ls -l "$CONFIG_FILE" | awk '{print $1}'))"
  if [[ -n "$PYTHON_BIN" ]]; then
    "$PYTHON_BIN" - "$CONFIG_FILE" <<'PY'
import json, sys
required = ("client_id", "client_secret", "refresh_token", "drive_file_id")
try:
    cfg = json.load(open(sys.argv[1]))
except Exception as exc:
    print(f"    UNREADABLE / invalid JSON: {exc}")
    sys.exit(0)
for key in required:
    val = cfg.get(key)
    placeholder = isinstance(val, str) and ("..." in val or val.strip() == "")
    state = "MISSING" if not val else ("STILL A PLACEHOLDER" if placeholder else "set")
    print(f"    {key}: {state}")
PY
  fi
else
  note "NO CONFIG at $CONFIG_FILE"
  add_problem "Config file missing at $CONFIG_FILE — copy mac/config.example.json there and fill it in."
fi

# 6. Can this python actually read chat.db? (the Full Disk Access test)
section "6. Full Disk Access (chat.db read test)"
if [[ ! -f "$CHAT_DB" ]]; then
  note "chat.db not found at $CHAT_DB — is Messages set up on this Mac?"
  add_problem "No Messages database at $CHAT_DB"
elif [[ -n "$PYTHON_BIN" ]]; then
  if "$PYTHON_BIN" - "$CHAT_DB" <<'PY'
import sqlite3, sys, urllib.parse
uri = f"file:{urllib.parse.quote(sys.argv[1])}?mode=ro"
try:
    conn = sqlite3.connect(uri, uri=True)
    n = conn.execute("SELECT COUNT(*) FROM message").fetchone()[0]
    conn.close()
    print(f"    OK — read {n} messages.")
except Exception as exc:
    print(f"    FAILED — {exc}")
    sys.exit(1)
PY
  then
    note "(this tested Terminal's access; the launchd job runs as python3 directly)"
  else
    add_problem "Cannot read chat.db — grant Full Disk Access to $PYTHON_BIN in System Settings > Privacy & Security > Full Disk Access."
  fi
fi

# Verdict
section "VERDICT"
if [[ "$problem_count" -eq 0 ]]; then
  echo "    No blocking problem found by these checks."
  echo "    If the export is still stale, run the exporter by hand and read the output:"
  echo "        ${PYTHON_BIN:-python3} <clone>/mac/export-imessages.py"
else
  echo "    $problem_count problem(s) found:"
  echo
  echo "$problem_list" | sed 's/^/    /'
  echo "    See mac/README.md 'Troubleshooting a stalled exporter' for detail."
fi
echo
