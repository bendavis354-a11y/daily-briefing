/**
 * Update assistant state after a successful build.
 *
 * Two modes:
 *   • Durable connector path (default for the scheduled routine): set
 *     CONNECTOR_STATE_FILE to the downloaded connector copy. This reads the
 *     current state from that file, merges this run in, and writes the next
 *     state to /tmp/next-state.json. It makes NO network calls — the caller
 *     uploads /tmp/next-state.json back to Drive with the connector.
 *   • Drive-OAuth path (when CONNECTOR_STATE_FILE is unset): re-authenticate
 *     on the durable Workspace account and overwrite the single fixed Drive
 *     state file in place.
 *
 * Both paths take the run's update data from /tmp/briefing-state-full.json,
 * which src/run-full-briefing.mjs writes at the end of the gather step.
 */
import fs from 'node:fs';

const now = new Date();
const connectorStateFile = process.env.CONNECTOR_STATE_FILE;

// Load this run's update data (written by run-full-briefing.mjs).
const updateData = JSON.parse(fs.readFileSync('/tmp/briefing-state-full.json', 'utf8'));
const todos = updateData.briefing?.sections?.todos || [];
const stats = updateData.briefing?.stats || {};

/**
 * Merge this run into a prior state object and return the next state.
 */
function buildNextState(currentState) {
  const newConversations = { ...(currentState.conversations || {}) };
  for (const c of updateData.conversations) {
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
        ...(c.sourceAccount && c.latestGmailThreadId ? { [c.sourceAccount]: c.latestGmailThreadId } : {})
      },
      lastSeenAt: now.toISOString(),
      summary: prior.summary || '',
      gmailThreadIds: prior.gmailThreadIds || []
    };
  }

  const openTasks = todos.map(t => ({
    text: t.text,
    priority: t.priority,
    account: t.account,
    addedAt: now.toISOString()
  }));

  const thisRun = {
    date: now.toISOString().slice(0, 10),
    completedAt: now.toISOString(),
    success: true,
    emailsScanned: stats.emailsScanned ?? updateData.conversations.length,
    urgent: stats.urgent ?? 0,
    eventsTomorrow: stats.eventsTomorrow ?? 0,
    eventsThisWeek: stats.eventsThisWeek ?? 0,
    suggestedReplies: stats.suggestedReplies ?? 0,
    todos: todos.length
  };
  const recentRuns = [thisRun, ...(currentState.recentRuns || [])].slice(0, 14);

  return {
    ...currentState,
    updatedAt: now.toISOString(),
    conversations: newConversations,
    openTasks,
    recentRuns
  };
}

if (connectorStateFile) {
  // Durable connector path — no network calls.
  const currentState = JSON.parse(fs.readFileSync(connectorStateFile, 'utf8'));
  const nextState = buildNextState(currentState);
  fs.writeFileSync('/tmp/next-state.json', JSON.stringify(nextState, null, 2));
  console.log(
    `Next state written to /tmp/next-state.json. ` +
    `Conversations: ${Object.keys(nextState.conversations).length}. Tasks: ${nextState.openTasks.length}.`
  );
} else {
  // Drive-OAuth path — overwrite the single fixed Drive state file in place.
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
  const nextState = buildNextState(currentState);
  await writeState({ accessToken: driveToken, fileId: driveFileId, state: nextState });
  console.log(
    `Drive state updated. Conversations: ${Object.keys(nextState.conversations).length}. ` +
    `Tasks: ${nextState.openTasks.length}.`
  );
}
