#!/usr/bin/env python3
"""
Mint a Google OAuth refresh token for the iMessage exporter, on this Mac.

The exporter needs a durable refresh token. Consumer @gmail.com accounts only
get 7-day tokens from an unverified app, so this must be run while signed in as
a WORKSPACE account (e.g. ben@heartspringgardens.org).

Usage:
    python3 mac/mint-refresh-token.py            (print the token)
    python3 mac/mint-refresh-token.py --write    (also save it to the config)

Reads client_id / client_secret from ~/.config/ben-briefing/imessage-export.json
so you never have to retype them. The client secret is never printed.

PREREQUISITE — the OAuth client must permit a loopback redirect:
  * "Desktop app" client type: works as-is, nothing to configure.
  * "Web application" client type: add the exact redirect URI this script
    prints to Google Cloud Console > Credentials > your client > Authorized
    redirect URIs, then run it again.

Dependencies: Python 3 standard library only.
"""

import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import socket
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
DEFAULT_CONFIG_PATH = Path.home() / ".config" / "ben-briefing" / "imessage-export.json"

# The exporter PATCHes a file it did not create, which drive.file cannot reach.
DEFAULT_SCOPE = "https://www.googleapis.com/auth/drive"

_result: dict = {}
_done = threading.Event()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        _result.update({k: v[0] for k, v in params.items()})
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        ok = "code" in _result
        msg = ("<h2>Authorization received.</h2><p>You can close this tab and "
               "return to Terminal.</p>") if ok else \
              f"<h2>Authorization failed.</h2><pre>{_result.get('error', 'unknown')}</pre>"
        self.wfile.write(f"<html><body style='font-family:system-ui;padding:3em'>{msg}</body></html>".encode())
        if "code" in _result or "error" in _result:
            _done.set()

    def log_message(self, *args):
        pass


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def load_client(config_path: Path) -> tuple:
    if not config_path.exists():
        sys.exit(f"ERROR: config not found at {config_path}\n"
                 "Create it from mac/config.example.json first.")
    cfg = json.loads(config_path.read_text(encoding="utf-8"))
    cid, csec = cfg.get("client_id"), cfg.get("client_secret")
    if not cid or not csec:
        sys.exit(f"ERROR: client_id / client_secret missing from {config_path}")
    return cid, csec, cfg


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))
    ap.add_argument("--scope", default=DEFAULT_SCOPE)
    ap.add_argument("--write", action="store_true",
                    help="save the new refresh_token into the config file")
    args = ap.parse_args()

    config_path = Path(args.config)
    client_id, client_secret, cfg = load_client(config_path)

    port = free_port()
    redirect_uri = f"http://127.0.0.1:{port}"
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    state = secrets.token_urlsafe(16)

    auth_url = AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": args.scope,
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
    })

    server = http.server.HTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    print(f"Redirect URI for this run: {redirect_uri}")
    print("If Google reports redirect_uri_mismatch, add that exact URI to your")
    print("OAuth client in Cloud Console (or switch it to a Desktop app client).")
    print()
    print("Sign in as the WORKSPACE account, not the @gmail.com one.")
    print("Opening your browser. If it does not open, visit:")
    print(auth_url)
    print()
    webbrowser.open(auth_url)

    if not _done.wait(timeout=300):
        server.shutdown()
        sys.exit("ERROR: timed out after 5 minutes waiting for authorization.")
    server.shutdown()

    if "error" in _result:
        sys.exit(f"ERROR: authorization failed: {_result['error']}")
    if _result.get("state") != state:
        sys.exit("ERROR: state mismatch — aborting.")

    body = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "code": _result["code"],
        "code_verifier": verifier,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
    }).encode()
    req = urllib.request.Request(
        TOKEN_URL, data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        sys.exit(f"ERROR: token exchange failed: {exc.code} "
                 f"{exc.read().decode('utf-8', 'replace')}")

    refresh = payload.get("refresh_token")
    if not refresh:
        sys.exit("ERROR: Google returned no refresh_token. Revoke the app's access at "
                 "https://myaccount.google.com/permissions and run this again.")

    print()
    print("SUCCESS. Refresh token:")
    print()
    print(f"    {refresh}")
    print()

    if args.write:
        cfg["refresh_token"] = refresh
        config_path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
        os.chmod(config_path, 0o600)
        print(f"Written to {config_path} (mode 600).")
        print("Now run the exporter to verify:")
        print("    python3 mac/export-imessages.py")
    else:
        print(f"Paste it into the refresh_token field of {config_path},")
        print("or re-run this with --write to save it automatically.")


if __name__ == "__main__":
    main()
