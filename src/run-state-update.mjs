/**
 * Update assistant state after a successful build.
 *
 * Two modes, matching the durability model:
 *
 *   1. Connector mode (CONNECTOR_STATE_FILE set) — the durable default.
 *      Reads the connector-downloaded state copy as the base, merges this run's
 *      conversations/todos/run-record into it, and writes the next state to a
 *      local file (NEXT_STATE_FILE, default /tmp/next-state.json). Makes NO
 *      network calls; the agent uploads the result with the Drive connector.
 *
 *   2. OAuth mode (CONNECTOR_STATE_FILE unset) — for when a Workspace account
 *      carries Drive scope. Reads the fixed Drive state file and overwrites it
 *      in place using the durable Workspace token (never the consumer token).
 *
 * The run payload comes from /tmp/briefing-state-full.json, written by
 * src/run-full-briefing.mjs (RUN_STATE_FILE overrides the path).
 */
import fs from 'node:fs';
import { getAccessToken } from './google-auth.mjs';
import { readState, writeState, emptyState } from './drive-state.mjs';
import { pickDriveAccount } from './accounts.mjs';

const now = new Date();
const connectorStateFile = process.env.CONNECTOR_STATE_FILE;
const runStateFile = process.env.RUN_STATE_FILE || '/tmp/briefing-state-full.json';
const nextStateFile = process.env.NEXT_STATE_FILE || '/tmp/next-state.json';

// Run payload written by run-full-briefing.mjs.
const payload = JSON.parse(fs.readFileSync(runStateFile, 'utf8'));
const runConversations = payload.conversations || [];
const todos = payload.briefing?.sections?.todos || [];

// ── Resolve the base state ────────────────────────────────────────────────────
let currentState;
let driveToken = null;
let driveFileId = null;

if (connectorStateFile) {
  // Durable connector path — base is the connector-downloaded copy, no network.
  currentState = JSON.parse(fs.readFileSync(connectorStateFile, 'utf8'));
  console.log(`Base state from connector file (version=${currentState.version}, updatedAt=${currentState.updatedAt})`);
} else {
  // OAuth path — read the fixed Drive file with the durable Workspace token.
  const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  driveFileId = process.env.DRIVE_STATE_FILE_ID;
  const driveAccount = pickDriveAccount(accounts);
  const driveRefreshToken = process.env[driveAccount.refreshTokenEnv];
  driveToken = await getAccessToken({ clientId, clientSecret, refreshToken: driveRefreshToken });
  currentState = await readState({ accessToken: driveToken, fileId: driveFileId });
  console.log(`Base state from Drive (account=${driveAccount.email}, version=${currentState.version})`);
}

if (!currentState || !currentState.version) currentState = { ...emptyState(), ...currentState };

// ── Merge this run's conversations ────────────────────────────────────────────
const newConversations = { ...(currentState.conversations || {}) };
for (const c of runConversations) {
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

// ── Open tasks from this run's todos ──────────────────────────────────────────
const openTasks = todos.map(t => ({
  text: t.text,
  priority: t.priority,
  account: t.account,
  addedAt: now.toISOString()
}));

// ── Recent runs (keep last 14) ────────────────────────────────────────────────
const thisRun = {
  date: now.toISOString().slice(0, 10),
  completedAt: now.toISOString(),
  success: true,
  emailsScanned: runConversations.length,
  todos: todos.length
};
const recentRuns = [thisRun, ...(currentState.recentRuns || [])].slice(0, 14);

const updatedState = {
  ...currentState,
  updatedAt: now.toISOString(),
  conversations: newConversations,
  openTasks,
  recentRuns
};

// ── Persist ───────────────────────────────────────────────────────────────────
if (connectorStateFile) {
  fs.writeFileSync(nextStateFile, JSON.stringify(updatedState, null, 2));
  console.log(`Next state written to ${nextStateFile}. Conversations: ${Object.keys(newConversations).length}. Tasks: ${openTasks.length}.`);
} else {
  await writeState({ accessToken: driveToken, fileId: driveFileId, state: updatedState });
  console.log(`Drive state updated. Conversations: ${Object.keys(newConversations).length}. Tasks: ${openTasks.length}.`);
}
