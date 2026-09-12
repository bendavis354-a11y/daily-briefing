/**
 * Background fact refresh.
 *
 * The briefing is written once a day at 5pm. Its analysis stays true all
 * evening — a Thursday call is still on Thursday — but its facts rot the moment
 * Ben answers something. This job re-reads the mailboxes every few minutes and
 * publishes just the volatile part, encrypted, next to the page. The page's
 * refresh button pulls it and reconciles in place.
 *
 * Deliberately NOT an agent run. It is plain deterministic code: scan, group,
 * infer status. It can say "this thread now has his reply on it" and "four
 * messages arrived since the brief was written". It cannot say whether any of
 * that matters — judgement stays with the daily run.
 *
 * Only the Workspace mailboxes are readable here, since the personal account's
 * consumer OAuth token expires weekly and needs an agent session holding the
 * Gmail connector. That covers less than it sounds: status is pooled per thread
 * (see reconcileThreadStatus), so a reply sent from a Workspace address also
 * settles the personal copy of the same thread.
 *
 * Writes `status.enc` to the deploy branch, in the same BAS1 container as
 * state.enc, under the same key — so the password Ben has already typed opens
 * it with no second prompt.
 *
 * Commits only when the facts actually changed. Run every ten minutes and most
 * runs are a no-op; committing each one would add tens of thousands of commits
 * a year to a repo whose whole job is to hold three small files.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { scanConfiguredMailboxes } from './gmail-api.mjs';
import { loadAccounts } from './accounts.mjs';
import { dedupeMessages, groupConversations, reconcileThreadStatus } from './continuity.mjs';
import { encryptState, decryptState, STATE_BRANCH } from './state-store.mjs';

export const STATUS_FILE = 'status.enc';
const WT = '/tmp/briefing-status-wt';
const git = (args, opts = {}) => execFileSync('git', args, { stdio: 'pipe', ...opts }).toString();

/**
 * The payload the page reconciles against. Kept to what the browser needs:
 * every scanned thread's current standing, plus enough to describe anything
 * that arrived since the brief was written. The page decides what is new,
 * because it is the only side that knows what it is already showing.
 */
export function buildStatusPayload(conversations, now = new Date()) {
  const threads = conversations.map(c => {
    const latest = c.latestMessage || {};
    return {
      key: c.conversationKey,
      account: latest.sourceAccount || '',
      status: c.status,
      latestFromMe: !!latest.fromMe,
      latestDate: latest.internalDate ? new Date(latest.internalDate).toISOString() : '',
      sender: String(latest.from || '').slice(0, 120),
      subject: String(latest.subject || '').slice(0, 200),
      threadId: latest.gmailThreadId || ''
    };
  });
  threads.sort((a, b) => String(a.key).localeCompare(String(b.key)));

  // Hash the facts, not the envelope: generatedAt changes every run and the
  // ciphertext changes with every salt, so neither can answer "did anything
  // actually change?".
  const contentHash = crypto.createHash('sha256')
    .update(JSON.stringify(threads)).digest('hex').slice(0, 32);

  return { version: 1, generatedAt: now.toISOString(), contentHash, threads };
}

/** The contentHash of what is already published, or null. */
function publishedHash(cwd) {
  try {
    execFileSync('git', ['fetch', 'origin', STATE_BRANCH], { cwd, stdio: 'pipe' });
    const buf = execFileSync('git', ['show', `origin/${STATE_BRANCH}:${STATUS_FILE}`], {
      cwd, maxBuffer: 32 * 1024 * 1024
    });
    return decryptState(buf, undefined, STATUS_FILE).contentHash || null;
  } catch {
    return null;
  }
}

function publish(payload) {
  try { git(['worktree', 'remove', '--force', WT]); } catch {}
  git(['worktree', 'add', '--detach', WT, `origin/${STATE_BRANCH}`]);
  fs.writeFileSync(`${WT}/${STATUS_FILE}`, encryptState(payload));
  git(['-C', WT, 'add', STATUS_FILE]);
  git(['-C', WT, 'commit', '-m', `Fact refresh ${payload.generatedAt}`]);
  git(['-C', WT, 'push', 'origin', `HEAD:refs/heads/${STATE_BRANCH}`]);
  try { git(['worktree', 'remove', '--force', WT]); } catch {}
}

async function main() {
  const now = new Date();
  const accounts = loadAccounts();
  const benEmails = accounts.map(a => a.email.toLowerCase());
  if (!benEmails.length) throw new Error('GMAIL_ACCOUNTS_JSON is empty');

  const results = await scanConfiguredMailboxes();
  const messages = results.flatMap(r => r.messages);
  console.log(`Scanned ${messages.length} messages from ${results.length} mailbox(es)`);

  const conversations = reconcileThreadStatus(
    groupConversations(dedupeMessages(messages), benEmails)
  );
  const payload = buildStatusPayload(conversations, now);
  const waiting = payload.threads.filter(t => t.status === 'waiting_on_ben').length;
  console.log(`${payload.threads.length} threads, ${waiting} awaiting Ben, hash=${payload.contentHash}`);

  const prior = publishedHash(process.cwd());
  if (prior === payload.contentHash) {
    console.log('Facts unchanged since the last publish — nothing to do.');
    return;
  }

  publish(payload);
  console.log(`Published ${STATUS_FILE} (was ${prior || 'absent'})`);
}

// Importable for tests; only scans when run directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(`Fact refresh failed: ${err.message}`);
    process.exit(1);
  });
}
