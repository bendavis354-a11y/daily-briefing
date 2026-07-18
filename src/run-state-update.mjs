/**
 * Update the Ben-assistant Drive state after a successful build.
 *
 * Two modes:
 *
 *  1. Connector mode (default for the durable routine): set CONNECTOR_STATE_FILE
 *     to the connector-downloaded state JSON. This reads that file, merges this
 *     run in memory, and writes the next state to /tmp/next-state.json. It makes
 *     NO network calls — the caller uploads /tmp/next-state.json back to Drive
 *     with the durable Workspace connector (create_file). This avoids any
 *     dependence on the weekly-expiring personal Drive token.
 *
 *  2. OAuth mode (only when a Workspace account has Drive scope): run WITHOUT
 *     CONNECTOR_STATE_FILE. This reads the current state from Drive and writes
 *     the merged state straight back to the single fixed DRIVE_STATE_FILE_ID.
 */
import fs from 'node:fs';

const now = new Date();
const connectorStateFile = process.env.CONNECTOR_STATE_FILE;

// The durable gather (run-full-briefing.mjs) exports the run payload here.
const payload = JSON.parse(fs.readFileSync('/tmp/briefing-state-full.json', 'utf8'));

// Update data: the active conversations seen this run and the briefing todos.
const updateConversations = payload.conversations || [];
const updateTodos = payload.briefing?.sections?.todos || payload.todos || [];

/**
 * Merge this run's conversations/todos into a base state object and return the
 * next state. Pure — no I/O, no network.
 */
function mergeState(currentState) {
  const newConversations = { ...(currentState.conversations || {}) };
  for (const c of updateConversations) {
    const key = c.conversationKey;
    const prior = newConversations[key] || {};
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
        ...(c.sourceAccount && c.latestGmailThreadId ? { [c.sourceAccount]: c.latestGmailThreadId } : {})
      },
      lastSeenAt: now.toISOString(),
      summary: prior.summary || '',
      gmailThreadIds: prior.gmailThreadIds || []
    };
  }

  const openTasks = updateTodos.map(t => ({
    text: t.text,
    priority: t.priority,
    account: t.account,
    addedAt: now.toISOString()
  }));

  const thisRun = {
    date: now.toISOString().slice(0, 10),
    completedAt: now.toISOString(),
    success: true,
    emailsScanned: updateConversations.length,
    todos: updateTodos.length
  };
  const recentRuns = [thisRun, ...(currentState.recentRuns || [])].slice(0, 14);

  return {
    ...currentState,
    version: currentState.version || 2,
    updatedAt: now.toISOString(),
    conversations: newConversations,
    openTasks,
    recentRuns
  };
}

if (connectorStateFile) {
  // Connector mode: no network calls.
  const currentState = JSON.parse(fs.readFileSync(connectorStateFile, 'utf8'));
  const updatedState = mergeState(currentState);
  fs.writeFileSync('/tmp/next-state.json', JSON.stringify(updatedState, null, 2));
  console.log(
    `Next state written to /tmp/next-state.json. ` +
    `Conversations: ${Object.keys(updatedState.conversations).length}. Tasks: ${updatedState.openTasks.length}. ` +
    `Upload it to Drive with the connector (create_file).`
  );
} else {
  // OAuth mode: read fresh from Drive and write straight back.
  const { getAccessToken } = await import('./google-auth.mjs');
  const { readState, writeState } = await import('./drive-state.mjs');
  const { pickDriveAccount } = await import('./accounts.mjs');

  const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const driveFileId = process.env.DRIVE_STATE_FILE_ID;

  const driveAccount = pickDriveAccount(accounts);
  const driveRefreshToken = process.env[driveAccount.refreshTokenEnv];
  const driveToken = await getAccessToken({ clientId, clientSecret, refreshToken: driveRefreshToken });

  const currentState = await readState({ accessToken: driveToken, fileId: driveFileId });
  const updatedState = mergeState(currentState);
  await writeState({ accessToken: driveToken, fileId: driveFileId, state: updatedState });
  console.log(`Drive state updated. Conversations: ${Object.keys(updatedState.conversations).length}. Tasks: ${updatedState.openTasks.length}.`);
}
