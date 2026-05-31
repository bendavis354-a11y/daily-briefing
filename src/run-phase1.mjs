/**
 * Phase 1 data gather: loads Drive state and scans Gmail.
 * Prints results to stdout as JSON.
 */
import { getAccessToken } from './google-auth.mjs';
import { readState, emptyState } from './drive-state.mjs';
import { scanConfiguredMailboxes } from './gmail-api.mjs';
import { dedupeMessages, groupConversations } from './continuity.mjs';

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const accounts = JSON.parse(process.env.GMAIL_ACCOUNTS_JSON || '[]');
const fileId = process.env.DRIVE_STATE_FILE_ID;

// Step 2: Load Drive state using first account
const firstAccount = accounts[0];
const driveRefreshToken = process.env[firstAccount.refreshTokenEnv];
const driveToken = await getAccessToken({ clientId, clientSecret, refreshToken: driveRefreshToken });

let assistantState;
try {
  assistantState = await readState({ accessToken: driveToken, fileId });
  process.stderr.write(`[drive] state loaded, version=${assistantState.version}, conversations=${Object.keys(assistantState.conversations || {}).length}\n`);
} catch (err) {
  process.stderr.write(`[drive] ERROR loading state: ${err.message}\n`);
  process.exit(1);
}

// Step 2.5: Scan Gmail
const benEmails = accounts.map(a => a.email);
let mailboxResults;
try {
  mailboxResults = await scanConfiguredMailboxes();
  process.stderr.write(`[gmail] scanned ${mailboxResults.length} mailboxes\n`);
} catch (err) {
  process.stderr.write(`[gmail] ERROR scanning: ${err.message}\n`);
  process.exit(1);
}

// Flatten all messages across all mailboxes
const allMessages = [];
const accessTokensByAccount = {};
for (const result of mailboxResults) {
  accessTokensByAccount[result.account.email] = result.accessToken;
  allMessages.push(...result.messages);
}
process.stderr.write(`[gmail] total messages before dedupe: ${allMessages.length}\n`);

const deduped = dedupeMessages(allMessages);
process.stderr.write(`[gmail] after dedupe: ${deduped.length}\n`);

const conversations = groupConversations(deduped, benEmails);
process.stderr.write(`[gmail] conversations: ${conversations.length}\n`);

// Output results as JSON (no sensitive snippets in stderr - only counts)
const output = {
  assistantState,
  conversations,
  driveToken,
  benEmails
};

process.stdout.write(JSON.stringify(output));
