#!/usr/bin/env python3
"""
Ben briefing — local iMessage exporter (runs on the Mac, NOT in the cloud).

Reads the last N hours of messages from the macOS Messages database
(~/Library/Messages/chat.db), builds the JSON envelope the cloud briefing
routine expects, and uploads it to the configured Google Drive file.

The cloud routine cannot read chat.db directly, so this script is the only
thing that keeps the iMessage data fresh. Schedule it with launchd (see
install.sh) so it catches up after the Mac wakes from sleep.

Dependencies: Python 3 standard library only (sqlite3, urllib, json).
No pip installs required.

Config: reads ~/.config/ben-briefing/imessage-export.json by default, or the
path in the BEN_IMESSAGE_CONFIG environment variable. Config shape:

{
  "client_id": "....apps.googleusercontent.com",
  "client_secret": "...",
  "refresh_token": "...",
  "drive_file_id": "...",          // DRIVE_IMESSAGE_FILE_ID
  "window_hours": 48               // optional, default 48
}
"""

import json
import os
import sqlite3
import sys
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Apple Cocoa Core Data epoch (2001-01-01) in Unix seconds.
APPLE_EPOCH = 978307200
TOKEN_URL = "https://oauth2.googleapis.com/token"
UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files/{file_id}?uploadType=media"

DEFAULT_CONFIG_PATH = Path.home() / ".config" / "ben-briefing" / "imessage-export.json"
DEFAULT_DB_PATH = Path.home() / "Library" / "Messages" / "chat.db"
DEFAULT_WINDOW_HOURS = 48
ADDRESSBOOK_BASE = Path.home() / "Library" / "Application Support" / "AddressBook"


def log(msg: str) -> None:
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"[{stamp}] {msg}", flush=True)


def load_config() -> dict:
    path = Path(os.environ.get("BEN_IMESSAGE_CONFIG", str(DEFAULT_CONFIG_PATH)))
    if not path.exists():
        log(f"ERROR: config not found at {path}")
        log("Create it from mac/config.example.json — see mac/README.md.")
        sys.exit(2)
    with open(path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    missing = [k for k in ("client_id", "client_secret", "refresh_token", "drive_file_id") if not cfg.get(k)]
    if missing:
        log(f"ERROR: config is missing required keys: {', '.join(missing)}")
        sys.exit(2)
    return cfg


def to_unix_seconds(raw_date) -> float:
    """Messages stores date as nanoseconds since 2001 (modern macOS) or
    seconds since 2001 (very old macOS). Normalize to Unix seconds."""
    if raw_date is None:
        return 0.0
    raw = float(raw_date)
    # 2024 in Apple-seconds is ~7.5e8; in Apple-nanoseconds ~7.5e17.
    if raw > 1e12:
        raw = raw / 1_000_000_000.0
    return raw + APPLE_EPOCH


def decode_attributed_body(blob) -> str:
    """Best-effort text extraction from the streamtyped attributedBody blob
    used by macOS Ventura+ when the plain `text` column is NULL.

    This is a heuristic, not a full typedstream parser: it locates the
    NSString class marker and reads the length-prefixed UTF-8 payload that
    follows. Good enough for briefing summaries; the plain `text` column is
    always preferred when present.
    """
    if not blob:
        return ""
    try:
        data = bytes(blob)
        marker = data.find(b"NSString")
        if marker == -1:
            return ""
        # Skip 'NSString' + ~5 bytes of class/version metadata.
        i = marker + len("NSString") + 5
        if i >= len(data):
            return ""
        length_byte = data[i]
        i += 1
        if length_byte == 0x81:
            length = int.from_bytes(data[i:i + 2], "little"); i += 2
        elif length_byte == 0x82:
            length = int.from_bytes(data[i:i + 4], "little"); i += 4
        else:
            length = length_byte
        text = data[i:i + length].decode("utf-8", errors="replace")
        # Strip stray control characters the heuristic can pick up.
        return "".join(ch for ch in text if ch == "\n" or ch >= " ").strip()
    except Exception:
        return ""


def load_contacts() -> dict:
    """Return a dict mapping normalized phone digits and lowercase emails to contact names.

    Reads every AddressBook-v22.abcddb source found on the system.
    Gracefully skips any DB it can't open (e.g. no Full Disk Access for Contacts).
    """
    contacts: dict = {}
    ab_paths = list(ADDRESSBOOK_BASE.glob("Sources/*/AddressBook-v22.abcddb"))
    ab_paths += list(ADDRESSBOOK_BASE.glob("AddressBook-v22.abcddb"))

    for ab_path in ab_paths:
        if not ab_path.exists():
            continue
        try:
            uri = f"file:{urllib.parse.quote(str(ab_path))}?mode=ro"
            conn = sqlite3.connect(uri, uri=True)
            conn.row_factory = sqlite3.Row

            # ROWID → "First Last"
            names: dict = {}
            try:
                for row in conn.execute("SELECT Z_PK, ZFIRSTNAME, ZLASTNAME FROM ZABCDRECORD"):
                    parts = [p for p in (row["ZFIRSTNAME"] or "", row["ZLASTNAME"] or "") if p and p.strip()]
                    if parts:
                        names[row["Z_PK"]] = " ".join(parts)
            except sqlite3.OperationalError:
                pass

            try:
                for row in conn.execute(
                    "SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL"
                ):
                    name = names.get(row["ZOWNER"])
                    if name:
                        digits = _digits_only(row["ZFULLNUMBER"])
                        if digits:
                            contacts[digits] = name
            except sqlite3.OperationalError:
                pass

            try:
                for row in conn.execute(
                    "SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL"
                ):
                    name = names.get(row["ZOWNER"])
                    if name:
                        email = (row["ZADDRESS"] or "").strip().lower()
                        if email:
                            contacts[email] = name
            except sqlite3.OperationalError:
                pass

            conn.close()
        except Exception:
            pass

    return contacts


def _digits_only(value: str) -> str:
    return "".join(ch for ch in str(value) if ch.isdigit())


def _resolve_handle(handle: str, contacts: dict) -> str:
    """Return the contact name for a handle, or the original handle if not found."""
    if not handle:
        return handle
    lower = handle.strip().lower()
    if "@" in lower:
        return contacts.get(lower, handle)
    digits = _digits_only(handle)
    if not digits:
        return handle
    if digits in contacts:
        return contacts[digits]
    # +15185675671 → try 10-digit without country code
    if len(digits) == 11 and digits.startswith("1"):
        hit = contacts.get(digits[1:])
        if hit:
            return hit
    # 10-digit → try with leading 1
    if len(digits) == 10:
        hit = contacts.get("1" + digits)
        if hit:
            return hit
    return handle


def read_messages(db_path: Path, window_hours: int, contacts: dict) -> list:
    if not db_path.exists():
        log(f"ERROR: Messages database not found at {db_path}")
        log("Is this a Mac with iMessage enabled? Has Full Disk Access been granted?")
        sys.exit(3)

    cutoff_unix = datetime.now(timezone.utc).timestamp() - window_hours * 3600

    # Open read-only so we never disturb the live Messages app.
    uri = f"file:{urllib.parse.quote(str(db_path))}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
    except sqlite3.OperationalError as exc:
        log(f"ERROR opening chat.db: {exc}")
        log("This usually means Full Disk Access is not granted to the program "
            "running this script (Terminal / python3). See mac/README.md.")
        sys.exit(3)

    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT
            m.ROWID            AS id,
            m.date             AS raw_date,
            m.is_from_me       AS is_from_me,
            m.text             AS text,
            m.attributedBody   AS attributed_body,
            h.id               AS handle,
            COALESCE(c.chat_identifier, h.id) AS chat_id,
            COALESCE(c.display_name, '')      AS chat_name
        FROM message m
        LEFT JOIN handle h            ON m.handle_id = h.ROWID
        LEFT JOIN chat_message_join j ON j.message_id = m.ROWID
        LEFT JOIN chat c              ON c.ROWID = j.chat_id
        ORDER BY m.date ASC
        """
    ).fetchall()
    conn.close()

    messages = []
    for row in rows:
        unix_seconds = to_unix_seconds(row["raw_date"])
        if unix_seconds < cutoff_unix:
            continue
        text = (row["text"] or "").strip()
        if not text:
            text = decode_attributed_body(row["attributed_body"])
        iso = datetime.fromtimestamp(unix_seconds, timezone.utc).isoformat(timespec="seconds")
        messages.append({
            "id": row["id"],
            "chat_id": row["chat_id"] or row["handle"] or "unknown",
            "chat_name": row["chat_name"] or "",
            "handle": row["handle"] or "",
            "sender_name": _resolve_handle(row["handle"] or "", contacts),
            "is_from_me": bool(row["is_from_me"]),
            "date": iso,
            "text": text,
        })
    return messages


def get_access_token(cfg: dict) -> str:
    body = urllib.parse.urlencode({
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "refresh_token": cfg["refresh_token"],
        "grant_type": "refresh_token",
    }).encode("utf-8")
    req = urllib.request.Request(
        TOKEN_URL, data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))["access_token"]
    except urllib.error.HTTPError as exc:
        log(f"ERROR: OAuth refresh failed: {exc.code} {exc.read().decode('utf-8', 'replace')}")
        log("Check client_id / client_secret / refresh_token in your config.")
        sys.exit(4)


def upload_to_drive(cfg: dict, access_token: str, payload: dict) -> None:
    data = json.dumps(payload).encode("utf-8")
    url = UPLOAD_URL.format(file_id=urllib.parse.quote(cfg["drive_file_id"]))
    req = urllib.request.Request(
        url, data=data, method="PATCH",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
    except urllib.error.HTTPError as exc:
        log(f"ERROR: Drive upload failed: {exc.code} {exc.read().decode('utf-8', 'replace')}")
        log("Check drive_file_id and that the refresh token has Drive access.")
        sys.exit(5)


def main() -> None:
    cfg = load_config()
    window_hours = int(cfg.get("window_hours", DEFAULT_WINDOW_HOURS))
    db_path = Path(cfg.get("db_path", str(DEFAULT_DB_PATH)))

    log("Loading contacts from AddressBook…")
    contacts = load_contacts()
    log(f"Loaded {len(contacts)} contact entries (phones + emails).")

    log(f"Reading messages from {db_path} (last {window_hours}h)…")
    messages = read_messages(db_path, window_hours, contacts)
    with_text = sum(1 for m in messages if m["text"])
    log(f"Collected {len(messages)} messages ({with_text} with text content).")

    payload = {
        "version": 1,
        "exportedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "windowHours": window_hours,
        "source": "macos-messages-chat-db",
        "messages": messages,
    }

    # Optional local copy for debugging (never committed to git).
    if os.environ.get("BEN_IMESSAGE_LOCAL_OUT"):
        out = Path(os.environ["BEN_IMESSAGE_LOCAL_OUT"])
        out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        log(f"Wrote local copy to {out}")

    log("Authenticating with Google…")
    token = get_access_token(cfg)
    log("Uploading export to Drive…")
    upload_to_drive(cfg, token, payload)
    log(f"Done. Uploaded {len(messages)} messages to Drive file {cfg['drive_file_id']}.")


if __name__ == "__main__":
    main()
