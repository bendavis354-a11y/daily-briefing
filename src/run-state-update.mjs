/**
 * Update the Drive assistant state after a successful build.
 *
 * Consumes the state payload written by src/run-full-briefing.mjs
 * (/tmp/briefing-state-full.json).
 *
 * Two modes:
 *   • Connector mode (CONNECTOR_STATE_FILE set): read that JSON as the base
 *     state, merge this run in, and write the next state to /tmp/next-state.json.
 *     Makes NO network calls — the caller uploads /tmp/next-state.json with the
 *     durable Drive connector. This is the default in the durable pipeline,
 *     because the personal OAuth token expires weekly.
 *   • OAuth mode (no CONNECTOR_STATE_FILE): re-authenticate on the durable
 *     Workspace account, read the current state fresh from Drive, merge, and
 *     write it straight back to the fixed DRIVE_STATE_FILE_ID.
 */
import fs from 'node:fs';

const PAYLOAD_FILE = process.env.BRIEFING_STATE_FILE || '/tmp/briefing-state-full.json';
const NEXT_STATE_FILE = process.env.NEXT_STATE_FILE || '/tmp/next-state.json';
const connectorStateFile = process.env.CONNECTOR_STATE_FILE;

const now = new Date();

// Load this run's payload (conversations seen, todos, and the base state snapshot).
const payload = JSON.parse(fs.readFileSync(PAYLOAD_FILE, 'utf8'));

// Resolve the base state to merge into.
let currentState;
if (connectorStateFile) {
  currentState = JSON.parse(fs.readFileSync(connectorStateFile, 'utf8'));
} else {
  // OAuth fallback: read the current state fresh from Drive.
  const { getAccessToken } = await import('./google-auth.mjs');
  const { readState } = await import('./drive-state.mjs');
  const { pickDriveAccount } = await import('./accounts.mjs');
  const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const driveFileId = process.env.DRIVE_STATE_FILE_ID || payload.driveFileId;
  const driveAccount = pickDriveAccount(accounts);
  const driveRefreshToken = process.env[driveAccount.refreshTokenEnv];
  const driveToken = await getAccessToken({ clientId, clientSecret, refreshToken: driveRefreshToken });
  currentState = await readState({ accessToken: driveToken, fileId: driveFileId });
  // Stash for the write-back below.
  currentState.__driveToken = driveToken;
  currentState.__driveFileId = driveFileId;
}

// Rebuild the conversations map, preserving prior per-conversation memory.
const newConversations = { ...currentState.conversations };
for (const c of payload.conversations) {
  const key = c.conversationKey;
  const prior = currentState.conversations?.[key] || {};
  newConversations[key] = {
    conversationKey: key,
    status: c.status,
    accountsSeen: c.accountsSeen,
    latestRfcMessageId: c.latestRfcMessageId || prior.latestRfcMessageId,
    subject: c.latestSubject || prior.subject,
    from: prior.from,
    gmailThreadIdByAccount: {
      ...(prior.gmailThreadIdByAccount || {}),
      ...(c.gmailThreadIdByAccount || {}),
      ...(c.sourceAccount && c.latestGmailThreadId
        ? { [c.sourceAccount]: c.latestGmailThreadId }
        : {})
    },
    lastSeenAt: now.toISOString(),
    summary: prior.summary || '',
    gmailThreadIds: prior.gmailThreadIds || []
  };
}

// Open tasks come from this run's todos.
const todos = payload.briefing?.sections?.todos || [];
const openTasks = todos.map(t => ({
  text: t.text,
  priority: t.priority,
  account: t.account,
  addedAt: now.toISOString()
}));

// Recent runs (keep last 14).
const thisRun = {
  date: now.toISOString().slice(0, 10),
  completedAt: now.toISOString(),
  success: true,
  emailsScanned: payload.conversations.length,
  todos: todos.length
};
const recentRuns = [thisRun, ...(currentState.recentRuns || [])].slice(0, 14);

const { __driveToken, __driveFileId, ...baseState } = currentState;
const updatedState = {
  ...baseState,
  updatedAt: now.toISOString(),
  conversations: newConversations,
  openTasks,
  recentRuns
};

if (connectorStateFile) {
  fs.writeFileSync(NEXT_STATE_FILE, JSON.stringify(updatedState, null, 2));
  console.log(
    `Next state written to ${NEXT_STATE_FILE}. ` +
    `Conversations: ${Object.keys(newConversations).length}. Tasks: ${openTasks.length}. ` +
    `(No network calls — upload with the Drive connector.)`
  );
} else {
  const { writeState } = await import('./drive-state.mjs');
  await writeState({ accessToken: __driveToken, fileId: __driveFileId, state: updatedState });
  console.log(
    `Drive state updated. Conversations: ${Object.keys(newConversations).length}. Tasks: ${openTasks.length}.`
  );
}
