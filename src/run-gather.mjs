import { getAccessToken } from './google-auth.mjs';
import { readState, emptyState } from './drive-state.mjs';
import { scanConfiguredMailboxes } from './gmail-api.mjs';
import { dedupeMessages, groupConversations } from './continuity.mjs';
import fs from 'node:fs';

const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const driveFileId = process.env.DRIVE_STATE_FILE_ID;

// STEP 2: Load assistant memory from Drive
let assistantState;
try {
  const firstAccount = accounts[0];
  const refreshToken = process.env[firstAccount.refreshTokenEnv];
  const driveToken = await getAccessToken({ clientId, clientSecret, refreshToken });
  assistantState = await readState({ accessToken: driveToken, fileId: driveFileId });
  console.error('[state] Loaded drive state, version=' + assistantState.version + ' updatedAt=' + assistantState.updatedAt);
} catch (err) {
  console.error('[state] ERROR loading drive state:', err.message);
  process.exit(1);
}

// STEP 2.5: Scan Gmail via direct API
console.error('[gmail] Scanning all mailboxes...');
const mailboxResults = await scanConfiguredMailboxes();

const allMessages = [];
const accessTokenByAccount = {};
for (const result of mailboxResults) {
  accessTokenByAccount[result.account.email] = result.accessToken;
  allMessages.push(...result.messages);
}
console.error('[gmail] Total raw messages:', allMessages.length);

const benEmails = accounts.map(a => a.email);
const deduped = dedupeMessages(allMessages);
console.error('[gmail] After dedup:', deduped.length);

const conversations = groupConversations(deduped, benEmails);
console.error('[gmail] Conversations:', conversations.length);

// Attach accessTokenByAccount and assistantState to output
const output = {
  assistantState,
  accessTokenByAccount,
  conversations,
  benEmails
};

fs.writeFileSync('/tmp/gather-output.json', JSON.stringify(output, null, 2));
console.error('[gather] Done. Output written to /tmp/gather-output.json');
