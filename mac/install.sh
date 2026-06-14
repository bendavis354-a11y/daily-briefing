#!/bin/bash
#
# Install the iMessage exporter as a launchd agent on this Mac.
#
# Runs every 2 hours. launchd coalesces missed runs, so if the Mac was asleep
# at a scheduled time it fires shortly after wake — keeping the export under
# the cloud routine's 6-hour staleness limit during normal use.
#
# Usage:
#   bash mac/install.sh
#
set -euo pipefail

LABEL="com.ben.imessage-export"
INTERVAL_SECONDS=7200   # every 2 hours

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
    <key>StartInterval</key>
    <integer>$INTERVAL_SECONDS</integer>
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
echo "    Loaded agent (runs every $((INTERVAL_SECONDS / 3600))h, and once now)."

cat <<NOTE

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
NOTE
