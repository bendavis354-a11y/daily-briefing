/**
 * Account-role helpers for the multi-account briefing pipeline.
 *
 * Each entry in GMAIL_ACCOUNTS_JSON may carry an optional `auth` field:
 *   - "oauth"     → mailbox is scanned via the custom Gmail OAuth app (durable
 *                   for Google Workspace accounts; provides full RFC822 headers).
 *   - "connector" → mailbox is read by the agent through the durable Gmail
 *                   connector and handed to the pipeline via a JSON file. Used
 *                   for consumer (gmail.com) accounts whose custom-OAuth refresh
 *                   token expires every 7 days. Connector messages have no
 *                   RFC822 headers, so continuity falls back to Gmail thread IDs
 *                   and content keys.
 * Missing `auth` defaults to "oauth" for backwards compatibility.
 *
 * Drive state I/O uses a single durable account, selected (in order) by:
 *   1. the account whose email === process.env.DRIVE_STATE_ACCOUNT
 *   2. the first account with `role: "drive"`
 *   3. the first `oauth` account (so state never rides the dying connector token)
 *   4. accounts[0] (legacy fallback)
 */

/**
 * Read the account list from the environment.
 *
 * Tolerant of one specific paste error, because it is the likeliest way this
 * ever breaks and the raw failure is unreadable. Copying the value out of a
 * shell or a settings box brings the surrounding quotes along, so the variable
 * holds `'[{"email"…}]'` rather than `[{"email"…}]`, and JSON.parse answers
 * "Unexpected token '''" — which says nothing about which variable is wrong or
 * what to do about it.
 *
 * Stripping matched outer quotes is safe: the value must be a JSON array, so
 * anything inside quotes was never valid to begin with. Anything else still
 * throws, but throws with the variable named and the value's opening shown.
 */
export function loadAccounts(raw = process.env.GMAIL_ACCOUNTS_JSON) {
  let text = String(raw ?? '').trim();
  if (!text) return [];

  const first = text[0];
  const last = text[text.length - 1];
  if ((first === "'" || first === '"') && last === first && text.length > 1) {
    const inner = text.slice(1, -1).trim();
    if (inner.startsWith('[') || inner.startsWith('{')) {
      console.warn('GMAIL_ACCOUNTS_JSON is wrapped in quotes — stripping them. Re-save it without the surrounding quotes.');
      text = inner;
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `GMAIL_ACCOUNTS_JSON is not valid JSON (${err.message}). ` +
      `It must be a JSON array and nothing else — no surrounding quotes. Value begins: ${text.slice(0, 24)}…`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('GMAIL_ACCOUNTS_JSON must be a JSON array of account objects.');
  }
  return parsed;
}

export function accountAuth(account) {
  return (account?.auth || 'oauth').toLowerCase();
}

export function isConnectorAccount(account) {
  return accountAuth(account) === 'connector';
}

/** Accounts scanned via the custom Gmail OAuth app (Workspace mailboxes). */
export function oauthAccounts(accounts) {
  return accounts.filter(a => !isConnectorAccount(a));
}

/** Accounts read through the Gmail connector (consumer mailboxes). */
export function connectorAccounts(accounts) {
  return accounts.filter(a => isConnectorAccount(a));
}

/**
 * Pick the durable account used for Drive state read/write. Never returns a
 * connector account, so state I/O does not depend on the weekly-expiring token.
 */
export function pickDriveAccount(accounts) {
  if (!accounts?.length) return null;

  const wanted = (process.env.DRIVE_STATE_ACCOUNT || '').trim().toLowerCase();
  if (wanted) {
    const match = accounts.find(a => a.email?.toLowerCase() === wanted);
    if (match) return match;
  }

  const byRole = accounts.find(a => a.role === 'drive');
  if (byRole) return byRole;

  const firstOauth = accounts.find(a => !isConnectorAccount(a));
  if (firstOauth) return firstOauth;

  return accounts[0];
}
