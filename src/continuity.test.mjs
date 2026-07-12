/**
 * Focused checks for continuity/dedup across OAuth (header-ful) and connector
 * (header-less) message sources. Run: node src/continuity.test.mjs
 */
import assert from 'node:assert';
import { dedupeMessages, groupConversations, buildConversationKey } from './continuity.mjs';

const BEN = ['ben@heartspringgardens.org', 'benjamin@biodynamics.com', 'bendavis354@gmail.com'];
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

// A message addressed to Ben at BOTH a personal and a Workspace address:
// one copy comes from the Workspace mailbox (OAuth, has RFC headers), the
// other from the personal mailbox (connector, no RFC headers).
const oauthCopy = {
  sourceAccount: 'ben@heartspringgardens.org',
  gmailMessageId: 'm-hs-1', gmailThreadId: 't-hs-1',
  rfcMessageId: '<abc@mail.gmail.com>', references: [], inReplyTo: '',
  from: 'Client <client@example.com>',
  to: 'ben@heartspringgardens.org, bendavis354@gmail.com',
  cc: '', subject: 'Project kickoff', snippet: 'Can we start Monday?',
  internalDate: 1700000000000, labelIds: ['INBOX']
};
const connectorCopy = {
  sourceAccount: 'bendavis354@gmail.com',
  gmailMessageId: 'm-pers-1', gmailThreadId: 't-pers-1',
  rfcMessageId: '', references: [], inReplyTo: '',
  from: 'Client <client@example.com>',
  to: 'ben@heartspringgardens.org, bendavis354@gmail.com',
  cc: '', subject: 'Project kickoff', snippet: 'Can we start Monday?',
  internalDate: 1700000000000, labelIds: ['INBOX']
};

check('cross-account duplicate collapses to one message', () => {
  const out = dedupeMessages([oauthCopy, connectorCopy]);
  assert.strictEqual(out.length, 1, `expected 1 message, got ${out.length}`);
});

check('merged representative keeps the RFC Message-ID', () => {
  const [rep] = dedupeMessages([connectorCopy, oauthCopy]);
  assert.strictEqual(rep.rfcMessageId, '<abc@mail.gmail.com>');
});

check('merged representative preserves both mailbox thread ids', () => {
  const [rep] = dedupeMessages([oauthCopy, connectorCopy]);
  assert.strictEqual(rep.gmailThreadIdByAccount['ben@heartspringgardens.org'], 't-hs-1');
  assert.strictEqual(rep.gmailThreadIdByAccount['bendavis354@gmail.com'], 't-pers-1');
});

check('cross-account copies land in ONE conversation (no split)', () => {
  const deduped = dedupeMessages([oauthCopy, connectorCopy]);
  const convos = groupConversations(deduped, BEN);
  assert.strictEqual(convos.length, 1, `expected 1 conversation, got ${convos.length}`);
});

// A personal-only thread that never touches a Workspace mailbox: two messages,
// no RFC headers, but the connector gives them the same Gmail thread id.
const personalA = {
  sourceAccount: 'bendavis354@gmail.com', gmailMessageId: 'p1', gmailThreadId: 'pt-9',
  rfcMessageId: '', references: [], inReplyTo: '',
  from: 'Elizabeth <elizabeth@mettabeefarm.com>', to: 'bendavis354@gmail.com',
  cc: '', subject: 'Clover??', snippet: 'Do you have extra seed?',
  internalDate: 1700000100000, labelIds: ['INBOX']
};
const personalB = {
  sourceAccount: 'bendavis354@gmail.com', gmailMessageId: 'p2', gmailThreadId: 'pt-9',
  rfcMessageId: '', references: [], inReplyTo: '',
  from: 'bendavis354@gmail.com', to: 'elizabeth@mettabeefarm.com',
  cc: '', subject: 'Re: Clover??', snippet: 'Yes, on the desk in the Hive.',
  internalDate: 1700000200000, labelIds: ['SENT']
};

check('header-less personal thread stays intact (grouped by thread id)', () => {
  const deduped = dedupeMessages([personalA, personalB]);
  assert.strictEqual(deduped.length, 2, 'distinct messages must not be deduped');
  const convos = groupConversations(deduped, BEN);
  assert.strictEqual(convos.length, 1, `expected 1 conversation, got ${convos.length}`);
  assert.strictEqual(convos[0].status, 'waiting_on_other', 'last msg is from Ben');
});

check('distinct messages in a thread are NOT collapsed by content key', () => {
  // personalA and personalB share subject family + participants but differ in
  // time/snippet, so the tight dedup key must keep them separate.
  assert.notStrictEqual(buildConversationKey(personalA), personalA.gmailMessageId);
  const out = dedupeMessages([personalA, personalB]);
  assert.strictEqual(out.length, 2);
});

check('unrelated messages remain separate conversations', () => {
  const deduped = dedupeMessages([oauthCopy, personalA]);
  const convos = groupConversations(deduped, BEN);
  assert.strictEqual(convos.length, 2);
});

console.log(`\n${passed} checks passed.`);
