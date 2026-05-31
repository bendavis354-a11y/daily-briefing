/**
 * Update Drive state after successful build
 */
import { getAccessToken } from './google-auth.mjs';
import { writeState } from './drive-state.mjs';
import fs from 'node:fs';

const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const driveFileId = process.env.DRIVE_STATE_FILE_ID;

const { assistantState, conversations } = JSON.parse(
  fs.readFileSync('/tmp/gather-output.json', 'utf8')
);

const now = new Date().toISOString();
const today = '2026-05-31';

// Get access token for Drive (first account)
const firstAccount = accounts[0];
const refreshToken = process.env[firstAccount.refreshTokenEnv];
const accessToken = await getAccessToken({ clientId, clientSecret, refreshToken });

// Build compact conversation summaries
const updatedConversations = { ...(assistantState.conversations || {}) };

for (const convo of conversations) {
  const msg = convo.latestMessage;
  if (!msg) continue;

  // Don't store full email bodies or private snippets
  const key = convo.conversationKey;
  const existing = updatedConversations[key] || {};

  updatedConversations[key] = {
    ...existing,
    conversationKey: key,
    status: convo.status,
    accountsSeen: convo.accountsSeen,
    subject: msg.subject || '',
    lastSeenAt: now,
    latestRfcMessageId: msg.rfcMessageId || existing.latestRfcMessageId || '',
    gmailThreadIds: {
      ...(existing.gmailThreadIds || {}),
      [msg.sourceAccount]: msg.gmailThreadId
    }
  };
}

// Build new state
const newState = {
  ...assistantState,
  version: 2,
  updatedAt: now,
  conversations: updatedConversations,
  openTasks: [],
  recentRuns: [
    {
      at: now,
      date: today,
      status: 'success',
      stats: {
        emailsScanned: 71,
        urgent: 0,
        eventsTomorrow: 1,
        proposedEvents: 3,
        suggestedReplies: 1,
        todos: 1
      }
    },
    ...(assistantState.recentRuns || []).slice(0, 13)
  ]
};

await writeState({ accessToken, fileId: driveFileId, state: newState });
console.log('Drive state updated successfully at', now);
