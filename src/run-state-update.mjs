/**
 * Update the Drive assistant state after a successful build.
 *
 * Two modes, selected by CONNECTOR_STATE_FILE:
 *
 *   1. Connector mode (CONNECTOR_STATE_FILE set) — the durable, network-free
 *      path. Reads the connector-provided copy of the state file, merges this
 *      run into it, and writes the next state to /tmp/next-state.json. The
 *      agent then uploads that file to Drive with the Gmail/Drive connector
 *      (create_file). No Drive-scoped OAuth token is required, so state I/O
 *      never depends on the weekly-expiring consumer token.
 *
 *   2. Legacy OAuth mode (CONNECTOR_STATE_FILE unset) — reads and overwrites a
 *      single fixed Drive file (DRIVE_STATE_FILE_ID) using the durable
 *      Workspace Drive OAuth token. Kept for setups that authorize a Workspace
 *      account with Drive scope.
 */
import fs from 'node:fs';
import { getAccessToken } from './google-auth.mjs';
import { readState, writeState } from './drive-state.mjs';
import { pickDriveAccount } from './accounts.mjs';

const now = new Date();
const connectorStateFile = process.env.CONNECTOR_STATE_FILE;

// Load this run's gather output. Prefer the full-pipeline payload
// (run-full-briefing.mjs → /tmp/briefing-state-full.json); fall back to the
// legacy phase-1 file (run-briefing.mjs → /tmp/briefing-state-update.json).
let updateData;
if (fs.existsSync('/tmp/briefing-state-full.json')) {
  const payload = JSON.parse(fs.readFileSync('/tmp/briefing-state-full.json', 'utf8'));
  updateData = {
    conversations: payload.conversations,
    todos: (payload.briefing?.sections?.todos || []).map(t => ({
      text: t.text,
      priority: t.priority,
      account: t.account
    }))
  };
} else {
  updateData = JSON.parse(fs.readFileSync('/tmp/briefing-state-update.json', 'utf8'));
}

function buildNextState(currentState) {
  // Rebuild conversations map
  const newConversations = { ...currentState.conversations };
  for (const c of updateData.conversations) {
    const key = c.conversationKey;
    const prior = currentState.conversations[key] || {};
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

  // Build open tasks from todos
  const openTasks = updateData.todos.map(t => ({
    text: t.text,
    priority: t.priority,
    account: t.account,
    addedAt: now.toISOString()
  }));

  // Build recent runs (keep last 14)
  const thisRun = {
    date: now.toISOString().slice(0, 10),
    completedAt: now.toISOString(),
    success: true,
    emailsScanned: updateData.conversations.length,
    todos: updateData.todos.length
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
  // Connector mode — no network calls.
  const currentState = JSON.parse(fs.readFileSync(connectorStateFile, 'utf8'));
  const updatedState = buildNextState(currentState);
  fs.writeFileSync('/tmp/next-state.json', JSON.stringify(updatedState, null, 2));
  console.log(
    `Next state written to /tmp/next-state.json. ` +
    `Conversations: ${Object.keys(updatedState.conversations).length}. Tasks: ${updatedState.openTasks.length}.`
  );
} else {
  // Legacy OAuth mode — read + overwrite the fixed Drive file.
  const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const driveFileId = process.env.DRIVE_STATE_FILE_ID;

  const driveAccount = pickDriveAccount(accounts);
  const driveRefreshToken = process.env[driveAccount.refreshTokenEnv];
  const driveToken = await getAccessToken({ clientId, clientSecret, refreshToken: driveRefreshToken });

  const currentState = await readState({ accessToken: driveToken, fileId: driveFileId });
  const updatedState = buildNextState(currentState);

  await writeState({ accessToken: driveToken, fileId: driveFileId, state: updatedState });
  console.log(
    `Drive state updated. ` +
    `Conversations: ${Object.keys(updatedState.conversations).length}. Tasks: ${updatedState.openTasks.length}.`
  );
}
