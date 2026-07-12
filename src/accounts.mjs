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
