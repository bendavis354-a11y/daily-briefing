#!/usr/bin/env python3
"""
Ben briefing — local iMessage exporter (runs on the Mac, NOT in the cloud).

Reads the last N hours of messages from the macOS Messages database
(~/Library/Messages/chat.db), builds the JSON envelope the cloud briefing
routine expects, encrypts it, and commits it to the deploy branch of the
briefing repo as `imessages.enc`.

The cloud routine cannot read chat.db directly, so this script is the only
thing that keeps the iMessage data fresh. Schedule it with launchd (see
install.sh) so it catches up after the Mac wakes from sleep.

Why git and not Google Drive (the old transport): the cloud side authenticates
as a Workspace account holding the `drive.file` scope, which only ever sees
files that same OAuth client created — an export uploaded by this script under
a different account was invisible to it, returning 404 no matter how the file
was shared. Worse, a consumer @gmail.com refresh token expires every 7 days, so
the upload half broke weekly by construction. Durable memory hit the identical
wall and moved into the repo; this now rides the same rails.

The payload is AES-256-GCM encrypted with the same BAS1 container the cloud
side uses for state.enc, so the repo may stay public. The key must match
STATE_ENCRYPTION_KEY (or BRIEFING_PASSWORD) in the cloud environment.

Dependencies: Python 3 standard library, plus `cryptography` for AES-GCM
(install.sh installs it; macOS ships no AES in the stdlib).

Config: reads ~/.config/ben-briefing/imessage-export.json by default, or the
path in the BEN_IMESSAGE_CONFIG environment variable. Config shape:

{
  "github_token": "github_pat_...",   // fine-grained PAT, Contents: read+write
  "github_repo": "owner/repo",
  "github_branch": "claude/briefing", // optional, default claude/briefing
  "encryption_key": "...",            // must equal cloud STATE_ENCRYPTION_KEY
  "window_hours": 48                  // optional, default 48
}
"""

import base64
import hashlib
import json
import os
import secrets
import sqlite3
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Apple Cocoa Core Data epoch (2001-01-01) in Unix seconds.
APPLE_EPOCH = 978307200
GITHUB_API = "https://api.github.com"
DEFAULT_BRANCH = "claude/briefing"
REMOTE_PATH = "imessages.enc"

# BAS1 container, byte-identical to src/state-store.mjs:
#   "BAS1" | salt(16) | iv(12) | ciphertext | authTag(16)
BAS1_MAGIC = b"BAS1"
PBKDF2_ITERATIONS = 250000

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
    missing = [k for k in ("github_token", "github_repo", "encryption_key") if not cfg.get(k)]
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


def encrypt_payload(payload: dict, password: str) -> bytes:
    """AES-256-GCM into the BAS1 container the cloud side decrypts.

    Kept byte-compatible with encryptState() in src/state-store.mjs: same
    PBKDF2-SHA256 derivation, same 250k iterations, same field order.
    """
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        log("ERROR: the 'cryptography' package is required for AES-256-GCM.")
        log("Install it with:  python3 -m pip install --user cryptography")
        log("(macOS ships no AES in the Python standard library.)")
        sys.exit(6)

    salt = secrets.token_bytes(16)
    iv = secrets.token_bytes(12)
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS, 32)
    plaintext = json.dumps(payload, indent=2).encode("utf-8")
    # AESGCM.encrypt returns ciphertext||tag, which is exactly the tail layout.
    sealed = AESGCM(key).encrypt(iv, plaintext, None)
    return BAS1_MAGIC + salt + iv + sealed


def _github_request(cfg: dict, method: str, path: str, body=None):
    # No `dict | None` annotation here: annotations evaluate at def time and
    # macOS still ships Python 3.9 via the Command Line Tools, where that form
    # raises TypeError on import.
    url = f"{GITHUB_API}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={
            "Authorization": f"Bearer {cfg['github_token']}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "ben-briefing-imessage-export",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    return json.loads(raw.decode("utf-8")) if raw else None


def push_to_github(cfg: dict, blob: bytes) -> None:
    """Commit the encrypted export to the deploy branch via the contents API.

    Uses the API rather than a git checkout so the exporter does not depend on
    the repo being cloned, or on git credentials, on this Mac.
    """
    repo = cfg["github_repo"]
    branch = cfg.get("github_branch", DEFAULT_BRANCH)
    path = f"/repos/{repo}/contents/{urllib.parse.quote(REMOTE_PATH)}"

    # An update needs the blob SHA it replaces; absence means first write.
    sha = None
    try:
        existing = _github_request(cfg, "GET", f"{path}?ref={urllib.parse.quote(branch)}")
        if isinstance(existing, dict):
            sha = existing.get("sha")
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            log(f"ERROR: could not read current {REMOTE_PATH}: {exc.code} "
                f"{exc.read().decode('utf-8', 'replace')[:300]}")
            sys.exit(5)

    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    body = {
        "message": f"iMessage export {stamp}",
        "content": base64.b64encode(blob).decode("ascii"),
        "branch": branch,
    }
    if sha:
        body["sha"] = sha

    try:
        _github_request(cfg, "PUT", path, body)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        log(f"ERROR: push of {REMOTE_PATH} failed: {exc.code} {detail}")
        if exc.code in (401, 403):
            log("The token is rejected. It must be a fine-grained PAT scoped to")
            log(f"{repo} with Contents: Read and write, and still be unexpired.")
        elif exc.code == 409:
            log("Conflict — the branch moved between read and write. The next")
            log("scheduled run (2 hours) will retry cleanly.")
        elif exc.code == 422:
            log(f"Branch {branch} may not exist in {repo}.")
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

    log("Encrypting export…")
    blob = encrypt_payload(payload, cfg["encryption_key"])

    branch = cfg.get("github_branch", DEFAULT_BRANCH)
    log(f"Pushing {len(blob)} bytes to {cfg['github_repo']}@{branch}:{REMOTE_PATH}…")
    push_to_github(cfg, blob)
    log(f"Done. Published {len(messages)} messages ({with_text} with text).")


if __name__ == "__main__":
    main()
