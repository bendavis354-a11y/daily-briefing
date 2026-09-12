#!/bin/bash
#
# Diagnose a stalled iMessage exporter. Run it on the Mac that is supposed to
# be exporting:
#
#   bash mac/diagnose.sh          report only, changes nothing
#   bash mac/diagnose.sh --fix    also repair what can be repaired
#
# --fix handles the failures that recur on their own schedule and have a known
# remedy: a Python upgrade that orphaned the encryption package, and a
# scheduled job that is no longer loaded or points at a stale path. It will not
# touch anything needing a human decision — a lapsed token, a revoked Full Disk
# Access grant, a key mismatch — it names those and stops.
#
# Secrets are never printed — the config check reports only which keys are
# present, never their values.
#
set -o pipefail

FIX=0
[[ "${1:-}" == "--fix" ]] && FIX=1

fix_list=""
record_fix() { fix_list="${fix_list}    - $1
"; }

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
    5) add_problem "Agent's last run exited 5: push to GitHub failed — check github_token (fine-grained PAT, Contents: Read and write, unexpired) and github_repo/github_branch. See the log below." ;;
    6) add_problem "Agent's last run exited 6: the 'cryptography' package is missing. Install it: python3 -m pip install --user cryptography" ;;
    2) add_problem "Agent's last run exited 2: config missing or incomplete at $CONFIG_FILE" ;;
    *) add_problem "Agent's last run exited $last_exit — see the log below." ;;
  esac
else
  note "NOT LOADED — launchctl does not know about $LABEL."
  needs_reinstall=1
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
      needs_reinstall=1
      add_problem "The launchd job points at $job_script which no longer exists. Re-run: bash mac/install.sh from the clone's current location."
    fi
  else
    note "could not parse a script path out of the plist."
  fi
else
  note "NO PLIST at $PLIST — the exporter was never installed on this Mac (or was uninstalled)."
  needs_reinstall=1
  add_problem "No launchd plist installed. Run: bash mac/install.sh"
fi

# 4. What does the log say?
section "4. Export log"
if [[ -f "$LOG_FILE" ]]; then
  note "log: $LOG_FILE"
  note "last modified: $(date -r "$LOG_FILE" 2>/dev/null)"
  last_ok="$(grep -E 'Done\. (Published|Uploaded)' "$LOG_FILE" 2>/dev/null | tail -1)"
  if [[ -n "$last_ok" ]]; then
    note "last successful publish: $last_ok"
  else
    note "no successful publish recorded in this log."
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
required = ("github_token", "github_repo", "encryption_key")
try:
    cfg = json.load(open(sys.argv[1]))
except Exception as exc:
    print(f"    UNREADABLE / invalid JSON: {exc}")
    sys.exit(0)
for key in required:
    val = cfg.get(key)
    placeholder = isinstance(val, str) and (
        "..." in val or val.strip() == "" or val.startswith("REPLACE_WITH")
    )
    state = "MISSING" if not val else ("STILL A PLACEHOLDER" if placeholder else "set")
    print(f"    {key}: {state}")
PY
  fi
else
  note "NO CONFIG at $CONFIG_FILE"
  add_problem "Config file missing at $CONFIG_FILE — copy mac/config.example.json there and fill it in."
fi

# 5B. Repair a job that is unloaded or pointing at a path that no longer exists.
#     Re-running the installer is the supported way to re-derive the absolute
#     paths it bakes into the plist, so --fix simply does that.
if [[ "$FIX" == "1" && "${needs_reinstall:-0}" == "1" ]]; then
  section "5B. Repairing the scheduled job"
  first_clone="$(echo "$clones" | head -1)"
  if [[ -n "$first_clone" ]]; then
    repo_root="$(cd "$(dirname "$first_clone")/.." && pwd)"
    note "re-running the installer from $repo_root…"
    if bash "$repo_root/mac/install.sh" >/dev/null 2>&1; then
      note "scheduled job REPAIRED."
      record_fix "reinstalled the launchd agent from $repo_root"
    else
      note "installer failed — run it by hand: bash $repo_root/mac/install.sh"
    fi
  else
    note "no clone found on this Mac, so there is nothing to reinstall from."
  fi
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

# 7. Is the AES dependency importable by the python launchd will use?
section "7. Encryption dependency"
if [[ -n "$PYTHON_BIN" ]]; then
  if "$PYTHON_BIN" -c "from cryptography.hazmat.primitives.ciphers.aead import AESGCM" 2>/dev/null; then
    note "cryptography: importable — AES-256-GCM available."
  elif [[ "$FIX" == "1" ]]; then
    note "cryptography: missing — reinstalling…"
    if "$PYTHON_BIN" -m pip install --user --quiet cryptography 2>&1 | sed 's/^/      /'; then
      if "$PYTHON_BIN" -c "from cryptography.hazmat.primitives.ciphers.aead import AESGCM" 2>/dev/null; then
        note "cryptography: REPAIRED."
        record_fix "reinstalled the cryptography package"
      else
        add_problem "Reinstalled 'cryptography' but it still will not import for $PYTHON_BIN."
      fi
    else
      add_problem "Could not reinstall 'cryptography'. Run by hand: $PYTHON_BIN -m pip install --user cryptography"
    fi
  else
    add_problem "The 'cryptography' package is missing or broken for $PYTHON_BIN. Re-run with --fix, or: $PYTHON_BIN -m pip install --user cryptography"
  fi
fi

# 8. Can the token actually write to the branch? (the check that matters most —
#    a silently unwritable destination is exactly how the old Drive path failed)
section "8. GitHub write access"
if [[ -f "$CONFIG_FILE" && -n "$PYTHON_BIN" ]]; then
  "$PYTHON_BIN" - "$CONFIG_FILE" <<'PY'
import json, sys, urllib.error, urllib.parse, urllib.request

try:
    cfg = json.load(open(sys.argv[1]))
except Exception as exc:
    print(f"    SKIPPED — config unreadable: {exc}")
    sys.exit(0)

token, repo = cfg.get("github_token"), cfg.get("github_repo")
branch = cfg.get("github_branch", "claude/briefing")
if not token or not repo or str(token).startswith("REPLACE_WITH"):
    print("    SKIPPED — github_token / github_repo not filled in yet.")
    sys.exit(0)

def call(path):
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "ben-briefing-diagnose",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8")), resp.headers

try:
    info, headers = call(f"/repos/{repo}")
    expiry = headers.get("github-authentication-token-expiration", "")
    if expiry:
        print(f"    token expires: {expiry}")
    else:
        print("    token expires: no expiry reported (classic token, or never expires)")
    perms = info.get("permissions", {})
    can_push = perms.get("push") or perms.get("maintain") or perms.get("admin")
    print(f"    repo {repo}: reachable, push={'yes' if can_push else 'NO'}")
    if not can_push:
        print("    PROBLEM: token cannot write. Needs Contents: Read and write.")
        sys.exit(1)
except urllib.error.HTTPError as exc:
    print(f"    PROBLEM: cannot reach {repo}: {exc.code} — token invalid, expired, or not scoped to this repo.")
    sys.exit(1)
except Exception as exc:
    print(f"    PROBLEM: network error contacting GitHub: {exc}")
    sys.exit(1)

try:
    call(f"/repos/{repo}/branches/{urllib.parse.quote(branch)}")[0]
    print(f"    branch {branch}: exists")
except urllib.error.HTTPError as exc:
    print(f"    PROBLEM: branch {branch} not found ({exc.code}).")
    sys.exit(1)

try:
    meta, _ = call(f"/repos/{repo}/contents/imessages.enc?ref={urllib.parse.quote(branch)}")
    print(f"    imessages.enc: present, {meta.get('size', '?')} bytes")
except urllib.error.HTTPError as exc:
    if exc.code == 404:
        print("    imessages.enc: not yet published (normal before the first run)")
    else:
        print(f"    imessages.enc: unexpected status {exc.code}")
PY
  if [[ $? -ne 0 ]]; then
    add_problem "GitHub write access check failed — see section 8 above. The cloud run cannot see iMessages until this passes."
  fi
else
  note "SKIPPED — no config or no python3."
fi

# Verdict
section "VERDICT"
if [[ -n "$fix_list" ]]; then
  echo "    Repaired:"
  echo "$fix_list"
fi

if [[ "$problem_count" -eq 0 ]]; then
  echo "    No blocking problem found by these checks."
else
  echo "    $problem_count problem(s) found:"
  echo
  echo "$problem_list" | sed 's/^/    /'
  if [[ "$FIX" != "1" ]]; then
    echo "    Some of these can be repaired automatically. Re-run with: bash mac/diagnose.sh --fix"
  fi
  echo "    See mac/README.md 'Troubleshooting a stalled exporter' for detail."
fi

# Whatever the verdict, the real proof is a successful run. With --fix, just do
# it: the point of that flag is that nobody has to work out the next step.
exporter_path="$(echo "${clones:-}" | head -1)"
if [[ "$FIX" == "1" && -n "$exporter_path" ]]; then
  section "Verifying with a live run"
  if "${PYTHON_BIN:-python3}" "$exporter_path" 2>&1 | sed 's/^/    /'; then
    echo
    echo "    The export published successfully. Tomorrow's briefing will have your texts."
  else
    echo
    echo "    The run failed. The output above names the reason."
  fi
elif [[ -n "$exporter_path" ]]; then
  echo "    To prove it end to end, run the exporter and read the output:"
  echo "        ${PYTHON_BIN:-python3} $exporter_path"
fi
echo
