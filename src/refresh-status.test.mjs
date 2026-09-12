/**
 * Checks for the background fact refresh payload: what it publishes, and the
 * change detection that keeps it from committing on every run.
 * Run: node src/refresh-status.test.mjs
 */
import assert from 'node:assert';
import { buildStatusPayload } from './refresh-status.mjs';

const NOW = new Date('2026-09-12T21:30:00Z');
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const convo = (key, status, latest) => ({
  conversationKey: key,
  status,
  latestMessage: {
    sourceAccount: 'ben@heartspringgardens.org',
    from: 'Andrea <andreac@urielpharmacy.com>',
    subject: 'Garden extract order delivery',
    internalDate: Date.parse('2026-09-12T18:00:00Z'),
    gmailThreadId: 'abc',
    ...latest
  }
});

check('publishes what the page needs to reconcile a row', () => {
  const p = buildStatusPayload([convo('<a@mail>', 'waiting_on_ben')], NOW);
  assert.strictEqual(p.threads.length, 1);
  const t = p.threads[0];
  assert.strictEqual(t.key, '<a@mail>');
  assert.strictEqual(t.status, 'waiting_on_ben');
  assert.strictEqual(t.latestFromMe, false);
  assert.strictEqual(t.account, 'ben@heartspringgardens.org');
  assert.ok(t.latestDate.startsWith('2026-09-12'), 'carries a parseable timestamp');
  assert.ok(t.subject && t.sender, 'carries enough to describe a new arrival');
});

check('generatedAt is the run time, so the page can date the facts', () => {
  const p = buildStatusPayload([], NOW);
  assert.strictEqual(p.generatedAt, NOW.toISOString());
});

// ── change detection ─────────────────────────────────────────────────────────
// Run every ten minutes, most runs find nothing new. Committing regardless
// would add tens of thousands of identical commits a year.
check('identical facts hash identically across runs', () => {
  const a = buildStatusPayload([convo('<a@mail>', 'waiting_on_ben')], NOW);
  const b = buildStatusPayload([convo('<a@mail>', 'waiting_on_ben')], new Date(NOW.getTime() + 600000));
  assert.strictEqual(a.contentHash, b.contentHash, 'the clock alone must not force a commit');
  assert.notStrictEqual(a.generatedAt, b.generatedAt);
});

check('a status change moves the hash', () => {
  const before = buildStatusPayload([convo('<a@mail>', 'waiting_on_ben')], NOW);
  const after = buildStatusPayload([convo('<a@mail>', 'waiting_on_other', { fromMe: true })], NOW);
  assert.notStrictEqual(before.contentHash, after.contentHash);
});

check('a new thread moves the hash', () => {
  const before = buildStatusPayload([convo('<a@mail>', 'waiting_on_ben')], NOW);
  const after = buildStatusPayload([convo('<a@mail>', 'waiting_on_ben'), convo('<b@mail>', 'waiting_on_ben')], NOW);
  assert.notStrictEqual(before.contentHash, after.contentHash);
});

check('scan order does not move the hash', () => {
  const a = buildStatusPayload([convo('<a@mail>', 'waiting_on_ben'), convo('<b@mail>', 'fyi')], NOW);
  const b = buildStatusPayload([convo('<b@mail>', 'fyi'), convo('<a@mail>', 'waiting_on_ben')], NOW);
  assert.strictEqual(a.contentHash, b.contentHash, 'Gmail returning threads in another order is not a change');
});

check('a conversation with no messages does not crash the run', () => {
  const p = buildStatusPayload([{ conversationKey: '<empty@mail>', status: 'unknown' }], NOW);
  assert.strictEqual(p.threads.length, 1);
  assert.strictEqual(p.threads[0].latestDate, '');
  assert.strictEqual(p.threads[0].latestFromMe, false);
});

console.log(`\n${passed} checks passed.`);
