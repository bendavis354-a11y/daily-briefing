#!/bin/bash
#
# Install the iMessage exporter as a launchd agent on this Mac.
#
# Runs hourly on the hour via StartCalendarInterval. That key, unlike
# StartInterval, fires the next time the Mac wakes if a scheduled time passed
# while it slept (launchd.plist(5)), so every wake produces a fresh export
# within minutes. The old StartInterval schedule restarted its two-hour timer
# on every wake, so a laptop opened for under two hours never uploaded at all.
#
# A sleeping Mac runs nothing. --wake-at schedules a daily wake shortly before
# the 5pm briefing so the export is fresh even if the lid was shut all
# afternoon (needs sudo; works when the Mac is on power).
#
# Usage:
#   bash mac/install.sh                  # install / reinstall the hourly job
#   bash mac/install.sh --wake-at 16:30  # also wake the Mac daily at 16:30
#
set -euo pipefail

LABEL="com.ben.imessage-export"
WAKE_AT=""

usage() { awk 'NR>2 && /^#/ {sub(/^# ?/, ""); print; next} NR>2 {exit}' "$0"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wake-at)   WAKE_AT="${2:-}"; shift 2 || { echo "ERROR: --wake-at needs HH:MM" >&2; exit 2; } ;;
    --wake-at=*) WAKE_AT="${1#*=}"; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           echo "ERROR: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -n "$WAKE_AT" && ! "$WAKE_AT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; then
  echo "ERROR: --wake-at takes a 24-hour local time like 16:30, got '$WAKE_AT'" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPORTER="$SCRIPT_DIR/export-imessages.py"
PYTHON_BIN="$(command -v python3 || true)"

CONFIG_DIR="$HOME/.config/ben-briefing"
CONFIG_FILE="$CONFIG_DIR/imessage-export.json"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/ben-briefing"

echo "==> Ben briefing iMessage exporter installer"

if [[ -z "$PYTHON_BIN" ]]; then
  echo "ERROR: python3 not found. Install the Xcode Command Line Tools:" >&2
  echo "       xcode-select --install" >&2
  exit 1
fi
echo "    python3:  $PYTHON_BIN"
echo "    exporter: $EXPORTER"

# 0. AES-256-GCM dependency. The export is encrypted before it is committed to
#    the repo, and macOS ships no AES in the Python standard library.
if "$PYTHON_BIN" -c "from cryptography.hazmat.primitives.ciphers.aead import AESGCM" 2>/dev/null; then
  echo "    cryptography: already installed"
else
  echo "    cryptography: installing (needed for AES-256-GCM)…"
  if "$PYTHON_BIN" -m pip install --user --quiet cryptography; then
    echo "    cryptography: installed"
  else
    echo "    WARNING: could not install 'cryptography'. Install it by hand:" >&2
    echo "             $PYTHON_BIN -m pip install --user cryptography" >&2
  fi
fi

# 1. Config scaffold (lives outside the repo so secrets never hit git).
mkdir -p "$CONFIG_DIR"
if [[ ! -f "$CONFIG_FILE" ]]; then
  cp "$SCRIPT_DIR/config.example.json" "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  echo "    Created config template at:"
  echo "        $CONFIG_FILE"
  echo "    >>> EDIT IT with your real credentials before the first run. <<<"
else
  echo "    Config already exists at $CONFIG_FILE (left untouched)."
fi

# 2. Log directory.
mkdir -p "$LOG_DIR"

# 3. Write the launchd plist with absolute paths.
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON_BIN</string>
        <string>$EXPORTER</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/export.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/export.log</string>
</dict>
</plist>
PLIST_EOF
echo "    Wrote launchd agent: $PLIST"

# 4. (Re)load the agent.
if launchctl list | grep -q "$LABEL"; then
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
fi
launchctl load "$PLIST"
echo "    Loaded agent (runs hourly on the hour, on every wake, and once now)."

# 5. Optional daily wake. pmset keeps a single repeating schedule, so this
#    replaces any existing one; show it first so nothing is lost silently.
if [[ -n "$WAKE_AT" ]]; then
  echo "    Current repeating power schedule:"
  pmset -g sched 2>/dev/null | sed 's/^/        /' || true
  echo "    Setting a daily wake at $WAKE_AT (replaces the schedule above; asks for your password)…"
  if sudo pmset repeat wakeorpoweron MTWRFSU "$WAKE_AT:00"; then
    echo "    Daily wake set. The hourly job fires on that wake and uploads."
  else
    echo "    WARNING: could not set the wake. Run by hand:" >&2
    echo "             sudo pmset repeat wakeorpoweron MTWRFSU $WAKE_AT:00" >&2
  fi
fi

cat <<NOTE

==> Fill in the config: $CONFIG_FILE
    github_token    fine-grained PAT, this repo only, Contents: Read and write
    github_repo     owner/repo of the briefing repository
    encryption_key  MUST equal the cloud's STATE_ENCRYPTION_KEY, or, when that
                    is not set, BRIEFING_PASSWORD (the briefing page password).
                    Mismatch = the cloud run reports a decryption error.

==> One more manual step: GRANT FULL DISK ACCESS
    macOS blocks reads of ~/Library/Messages/chat.db unless the program
    running the job has Full Disk Access.

    System Settings > Privacy & Security > Full Disk Access >
      add and enable:  $PYTHON_BIN
    (You may also need to add Terminal if you run it by hand.)

==> Verify it works:
    Run once by hand:   $PYTHON_BIN $EXPORTER
    Watch the log:      tail -f $LOG_DIR/export.log
    Check it is loaded: launchctl list | grep $LABEL

==> To uninstall:
    launchctl unload $PLIST && rm $PLIST
    sudo pmset repeat cancel     # only if you used --wake-at
NOTE
