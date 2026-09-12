/**
 * Checks that "Reply to iMessage" items are raised only for texts that
 * actually await Ben. Run: node src/imessage-triage.test.mjs
 */
import assert from 'node:assert';
import { triageChat, isAcknowledgement, isReaction, isGroupChat } from './imessage-triage.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const at = (h, m = 0) => new Date(Date.UTC(2026, 8, 11, h, m)).toISOString();
const them = (text, h, m, extra = {}) => ({ text, is_from_me: false, date: at(h, m), sender_name: 'Them', ...extra });
const me = (text, h, m) => ({ text, is_from_me: true, date: at(h, m) });

check('a tapback on Ben’s own message needs no reply', () => {
  const t = triageChat('+1555', [them('How did it go?', 9), me('Seems to fit pretty well', 10), them('Liked “Seems to fit pretty well ”', 11)]);
  assert.strictEqual(t.needsReply, false);
  assert.strictEqual(t.reason, 'ben spoke last');
});

check('"Perfect we’re here" after his message closes the exchange', () => {
  const t = triageChat('+1555', [them('Is 915 okay for pickups', 8), me('Yes I’ll be there', 9), them('Perfect we’re here', 9, 30)]);
  assert.strictEqual(t.needsReply, false);
  assert.strictEqual(t.reason, 'acknowledgement');
});

check('"OK will do" and "Ok thank you. It will be nice." are acknowledgements', () => {
  assert.ok(isAcknowledgement('OK will do'));
  assert.ok(isAcknowledgement('Ok thank you. It will be nice.'));
  assert.ok(!isAcknowledgement('Ok looking sparse ? Hope we have a few ! Thx'), 'a question is not an acknowledgement');
  assert.ok(!isAcknowledgement('Will do thanks\n\nI’m on town and will stop by on my way back'));
});

check('his phone’s driving auto-reply is not his reply', () => {
  const t = triageChat('x@y', [
    them('Are you at the garden this afternoon after 3:30?', 12),
    me('Sure, stop by.', 12, 30),
    them('Ok thank you. It will be nice.', 13),
    me('I’m driving with Focus turned on. I’ll see your message when I get where I’m going.', 13, 5)
  ]);
  assert.strictEqual(t.needsReply, false);
  assert.strictEqual(t.reason, 'acknowledgement', 'the acknowledgement is the last real message');
});

check('a family-group question to someone else is not his to answer', () => {
  const chat = [
    them('I’m going to get an X-ray', 9, 0, { sender_name: 'Phillip' }),
    them('Good you went to the doctor. Is the x ray done?', 10, 0, { sender_name: 'Valeska' })
  ];
  const t = triageChat('chat828910144788291790', chat);
  assert.strictEqual(t.needsReply, false);
  assert.match(t.reason, /group/);
});

check('a group message that names him does await him', () => {
  const t = triageChat('chat1', [them('Ben, can you bring the trailer?', 9, 0, { sender_name: 'Jonas' })]);
  assert.strictEqual(t.needsReply, true);
});

check('an image-only message keeps the last text as its excerpt', () => {
  const t = triageChat('+1555', [me('It’s a thing of beauty', 9), them('So so happy to see the depth of action.', 10), them('￼￼￼', 11)]);
  assert.strictEqual(t.needsReply, true);
  assert.strictEqual(t.excerpt, 'So so happy to see the depth of action.');
});

check('a real unanswered message still needs a reply', () => {
  const t = triageChat('+1555', [me('Thanks for the photos', 9), them('I assume it disappears, steaming it for nettle pesto does:)', 10)]);
  assert.strictEqual(t.needsReply, true);
});

check('group detection reads the chat id and the sender count', () => {
  assert.ok(isGroupChat('chat935802020514112133', []));
  assert.ok(!isGroupChat('+15185674252', [them('a', 1)]));
  assert.ok(isGroupChat('+1', [them('a', 1, 0, { sender_name: 'A' }), them('b', 2, 0, { sender_name: 'B' })]));
  assert.ok(isReaction('Loved “See you soon”'));
});

console.log(`\n${passed} checks passed`);
