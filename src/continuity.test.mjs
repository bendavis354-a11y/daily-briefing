/**
 * Focused checks for continuity/dedup across OAuth (header-ful) and connector
 * (header-less) message sources. Run: node src/continuity.test.mjs
 */
import assert from 'node:assert';
import { dedupeMessages, groupConversations, buildConversationKey, inferStatus, reconcileThreadStatus } from './continuity.mjs';

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

// ── who the thread is actually waiting on ────────────────────────────────────
// "The newest message is not Ben's" is sound for a two-person exchange and
// wrong for a committee: he votes, colleagues reply to each other, and the
// thread reads as though it were waiting on him.
const msg = (from, opts = {}) => ({
  from, to: opts.to || '', cc: opts.cc || '',
  internalDate: opts.at || 0, subject: opts.subject || 'Re: something',
  fromMe: BEN.some(e => from.toLowerCase().includes(e)),
  labelIds: opts.labelIds || []
});

check('two-person thread with their message last still waits on Ben', () => {
  const convo = { messages: [
    msg('sarah@demeter-usa.org', { to: 'ben@heartspringgardens.org', at: 1 }),
    msg('ben@heartspringgardens.org', { to: 'sarah@demeter-usa.org', at: 2 }),
    msg('sarah@demeter-usa.org', { to: 'ben@heartspringgardens.org', at: 3 })
  ] };
  assert.strictEqual(inferStatus(convo), 'waiting_on_ben');
});

check('committee thread he has answered reads as continued, not waiting', () => {
  // The real case: Ben votes, then two colleagues approve to each other.
  const cc = 'carin@biodynamics.com, mmueller@biodynamics.com, dorothy@biodynamics.com';
  const convo = { messages: [
    msg('coree@biodynamics.com', { to: 'benjamin@biodynamics.com', cc, at: 1 }),
    msg('benjamin@biodynamics.com', { to: 'coree@biodynamics.com', cc, at: 2 }),
    msg('dorothy@biodynamics.com', { to: 'benjamin@biodynamics.com', cc, at: 3 }),
    msg('coree@biodynamics.com', { to: 'carin@biodynamics.com', cc, at: 4 })
  ] };
  assert.strictEqual(inferStatus(convo), 'thread_continued');
});

check('a group thread he has NEVER answered still waits on him', () => {
  const cc = 'carin@biodynamics.com, mmueller@biodynamics.com';
  const convo = { messages: [
    msg('coree@biodynamics.com', { to: 'benjamin@biodynamics.com', cc, at: 1 }),
    msg('dorothy@biodynamics.com', { to: 'benjamin@biodynamics.com', cc, at: 2 })
  ] };
  assert.strictEqual(inferStatus(convo), 'waiting_on_ben', 'silence on a group ask is still his to answer');
});

check('his own message last still reads as waiting on them', () => {
  const convo = { messages: [
    msg('coree@biodynamics.com', { to: 'benjamin@biodynamics.com', cc: 'carin@biodynamics.com', at: 1 }),
    msg('benjamin@biodynamics.com', { to: 'coree@biodynamics.com', cc: 'carin@biodynamics.com', at: 2 })
  ] };
  assert.strictEqual(inferStatus(convo), 'waiting_on_other');
});

check('newsletters are still fyi, never continued', () => {
  const convo = { messages: [
    msg('benjamin@biodynamics.com', { to: 'list@x.org', cc: 'a@x.org, b@x.org', at: 1 }),
    msg('newsletter@x.org', { to: 'list@x.org', cc: 'a@x.org, b@x.org', at: 2, subject: 'The weekly newsletter' })
  ] };
  assert.strictEqual(inferStatus(convo), 'fyi');
});

check('an empty conversation is unknown, not waiting', () => {
  assert.strictEqual(inferStatus({ messages: [] }), 'unknown');
});

// ── pooling evidence across mailboxes ────────────────────────────────────────
// The same thread can survive as two conversations (Workspace copy + personal
// copy). When he answers from the Workspace address, only that copy holds the
// reply, and the other keeps asking for what he has already sent.
check('a reply in one mailbox silences the copy in another', () => {
  const workspace = {
    conversationKey: '<abc@mail>', status: 'waiting_on_other',
    latestMessage: { subject: 'Re: Garden extract order delivery' },
    messages: [msg('andrea@urielpharmacy.com', { at: 1 }), msg('ben@heartspringgardens.org', { at: 2 })]
  };
  const personal = {
    conversationKey: 'gthread:bendavis354@gmail.com:123', status: 'waiting_on_ben',
    latestMessage: { subject: 'Garden extract order delivery' },
    messages: [msg('andrea@urielpharmacy.com', { at: 1 })]
  };
  reconcileThreadStatus([workspace, personal]);
  assert.strictEqual(personal.status, 'thread_continued', 'the personal copy stops nagging');
  assert.strictEqual(workspace.status, 'waiting_on_other', 'the answered copy is untouched');
});

check('a thread he has answered nowhere keeps asking', () => {
  const a = {
    status: 'waiting_on_ben', latestMessage: { subject: 'Re: payment processing protocols' },
    messages: [msg('coree@biodynamics.com', { at: 1 })]
  };
  const b = {
    status: 'waiting_on_ben', latestMessage: { subject: 'payment processing protocols' },
    messages: [msg('coree@biodynamics.com', { at: 1 })]
  };
  reconcileThreadStatus([a, b]);
  assert.strictEqual(a.status, 'waiting_on_ben');
  assert.strictEqual(b.status, 'waiting_on_ben');
});

check('reconciliation never promotes a thread to needing attention', () => {
  const answered = {
    status: 'waiting_on_other', latestMessage: { subject: 'Re: Demeter Reach Out!' },
    messages: [msg('ben@heartspringgardens.org', { at: 2 })]
  };
  const fyi = {
    status: 'fyi', latestMessage: { subject: 'Demeter Reach Out!' },
    messages: [msg('sarah@demeter-usa.org', { at: 1 })]
  };
  reconcileThreadStatus([answered, fyi]);
  assert.strictEqual(fyi.status, 'fyi', 'only waiting_on_ben is ever downgraded');
});

// ── a message put to Ben alone waits on him, whatever the thread's history ──
check('a two-way exchange inside a thread that began as a group waits on Ben', () => {
  // Newman introduces Crockett and Ben (three parties); it becomes Crockett
  // and Ben trading availability. Crockett's latest is addressed to Ben only.
  const convo = { messages: [
    msg('dnewman@arthurspointfarm.com', { to: 'bendavis354@gmail.com, ben@berkshireagventures.org', at: 1 }),
    msg('bendavis354@gmail.com', { to: 'dnewman@arthurspointfarm.com', cc: 'ben@berkshireagventures.org', at: 2 }),
    { ...msg('ben@berkshireagventures.org', { to: 'bendavis354@gmail.com', at: 3 }), toMeOnly: true }
  ] };
  assert.strictEqual(inferStatus(convo), 'waiting_on_ben');
});

check('a greeting that names him counts as addressed to him', () => {
  const cc = 'coree@biodynamics.com, dorothy@biodynamics.com';
  const convo = { messages: [
    msg('benjamin@biodynamics.com', { to: 'zachary@biodynamics.com', cc, at: 1 }),
    { ...msg('zachary@biodynamics.com', { to: 'benjamin@biodynamics.com', cc, at: 2 }), namesMe: true }
  ] };
  assert.strictEqual(inferStatus(convo), 'waiting_on_ben');
});

check('a reply-all that lands in his To with the committee in Cc is not directed', () => {
  // Chelsea replies to Ben's "I plan to be there": To Ben, ten in Cc, "Hey everyone".
  const [convo] = groupConversations([
    { ...oauthCopy, gmailMessageId: 'g1', gmailThreadId: 't-abo', rfcMessageId: '', from: 'Benjamin Davis <bendavis354@gmail.com>', to: 'beth@goodfootfarm.com', cc: 'alex@spikenardfarm.org, gobiodynamic@gmail.com', subject: 'Re: ABO Meeting', snippet: 'Hello all, I plan to be there.', internalDate: 1 },
    { ...oauthCopy, gmailMessageId: 'g2', gmailThreadId: 't-abo', rfcMessageId: '', from: 'Chelsea <cnolan214@gmail.com>', to: 'bendavis354@gmail.com', cc: 'beth@goodfootfarm.com, alex@spikenardfarm.org, gobiodynamic@gmail.com', subject: 'Re: ABO Meeting', snippet: 'Hey everyone, I’m happy to share an update on the rebrand.', internalDate: 2 }
  ], BEN);
  assert.strictEqual(convo.status, 'thread_continued');
  const [direct] = groupConversations([
    { ...oauthCopy, gmailMessageId: 'g3', gmailThreadId: 't-bav', rfcMessageId: '', from: 'bendavis354@gmail.com', to: 'ben@berkshireagventures.org', cc: 'dnewman@arthurspointfarm.com', subject: 'Re: Connecting BAV', snippet: 'Thanks Dave!', internalDate: 1 },
    { ...oauthCopy, gmailMessageId: 'g4', gmailThreadId: 't-bav', rfcMessageId: '', from: 'ben@berkshireagventures.org', to: 'bendavis354@gmail.com', cc: '', subject: 'Re: Connecting BAV', snippet: 'Roger that, here’s next week’s availability', internalDate: 2 }
  ], BEN);
  assert.strictEqual(direct.status, 'waiting_on_ben', 'a two-way message with no one copied is his');
});

check('calendar responses and notification senders are fyi', () => {
  assert.strictEqual(inferStatus({ messages: [msg('gobiodynamic@gmail.com', { subject: 'Accepted: ABO Working Group @ Thu Sep 10', at: 1 })] }), 'fyi');
  assert.strictEqual(inferStatus({ messages: [msg('quickbooks@notification.intuit.com', { subject: 'Invoice JH102520 from Jiffy Hitch', at: 1 })] }), 'fyi');
  assert.strictEqual(inferStatus({ messages: [msg('drive-shares-dm-noreply@google.com', { subject: 'Document shared with you: "2026.09.09"', at: 1 })] }), 'fyi');
});

check('reconciliation keeps a fresh ask put to him after his last word', () => {
  const workspace = {
    status: 'waiting_on_other', latestMessage: { subject: 'Re: Connecting BAV & Heart Spring Gardens' },
    messages: [msg('ben@berkshireagventures.org', { at: 1 }), msg('bendavis354@gmail.com', { at: 2 })]
  };
  const later = { ...msg('ben@berkshireagventures.org', { subject: 'Re: Connecting BAV & Heart Spring Gardens', at: 3 }), toMeOnly: true };
  const personal = { status: 'waiting_on_ben', latestMessage: later, messages: [msg('bendavis354@gmail.com', { at: 2 }), later] };
  reconcileThreadStatus([workspace, personal]);
  assert.strictEqual(personal.status, 'waiting_on_ben', 'they wrote to him after he replied');
});

check('reconciliation still silences a copy his later reply answered', () => {
  const asked = { ...msg('coree@biodynamics.com', { subject: 'quick notes from today’s meeting', at: 1 }), namesMe: true };
  const personal = { status: 'waiting_on_ben', latestMessage: asked, messages: [asked] };
  const workspace = {
    status: 'waiting_on_other', latestMessage: { subject: 'Re: quick notes from today’s meeting' },
    messages: [asked, msg('benjamin@biodynamics.com', { at: 2 })]
  };
  reconcileThreadStatus([workspace, personal]);
  assert.strictEqual(personal.status, 'thread_continued', 'his reply came after the ask');
});

check('short subjects never pool, since they collide across threads', () => {
  const a = { status: 'waiting_on_ben', latestMessage: { subject: 'Hi' }, messages: [msg('x@y.com', { at: 1 })] };
  const b = { status: 'waiting_on_other', latestMessage: { subject: 'Hi' }, messages: [msg('ben@heartspringgardens.org', { at: 2 })] };
  reconcileThreadStatus([a, b]);
  assert.strictEqual(a.status, 'waiting_on_ben', 'an unrelated "Hi" must not be silenced');
});

console.log(`\n${passed} checks passed.`);
