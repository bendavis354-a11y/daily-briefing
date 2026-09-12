/**
 * Checks that meeting proposals come only from unanswered invitations that
 * name a time, never from Ben's own messages or from stray keywords.
 * Run: node src/meeting-detect.test.mjs
 */
import assert from 'node:assert';
import { findMeetingProposal, isMeetingProposalText, unansweredTail } from './meeting-detect.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const at = (h, m = 0) => new Date(Date.UTC(2026, 8, 11, h, m)).toISOString();
const them = (text, h, m) => ({ text, is_from_me: false, date: at(h, m) });
const me = (text, h, m) => ({ text, is_from_me: true, date: at(h, m) });

// ── the false positives that prompted this ───────────────────────────────────
check('a chat ending in "Bummer" proposes nothing', () => {
  const chat = [
    them('I’ll be over at the house later', 9),
    them('Not anymore had two call out sick. Going to have to close', 10),
    me('Bummer', 11)
  ];
  assert.strictEqual(findMeetingProposal(chat), null);
});

check('a meeting word and a time word in different messages do not combine', () => {
  const chat = [them('Can we call sometime?', 9), them('Beautiful morning here', 10)];
  assert.strictEqual(findMeetingProposal(chat), null);
});

check('Ben’s own concrete offer raises nothing — he is driving it', () => {
  const chat = [
    them('Can’t make tu/th work. I can come Saturday. What time?', 9),
    me('Saturday the 19th at 10. We could have a quick lunch together', 10),
    me('I also want to come over and see your garden', 10, 5)
  ];
  assert.strictEqual(findMeetingProposal(chat), null);
});

check('an answered invitation is not re-proposed', () => {
  const chat = [
    them('Hi Ben, are you at the garden this afternoon after 3:30?', 12),
    me('Sure, stop by. I will be on the tractor', 12, 30),
    them('Ok thank you. It will be nice.', 13)
  ];
  assert.strictEqual(findMeetingProposal(chat), null);
});

check('a time on its own is not an invitation', () => {
  const chat = [them('I’m taking the drone for a spin on Monday so I’ll send more pics then', 9)];
  assert.strictEqual(findMeetingProposal(chat), null);
});

// ── the real thing ───────────────────────────────────────────────────────────
check('an unanswered "can we meet Tuesday afternoon" is proposed', () => {
  const chat = [me('Great to see you', 8), them('Can we meet Tuesday afternoon to go over the plan?', 9)];
  const hit = findMeetingProposal(chat);
  assert.ok(hit);
  assert.match(hit.text, /Tuesday/);
});

check('the latest qualifying ask wins', () => {
  const chat = [
    them('Want to grab lunch Thursday?', 9),
    them('Actually, could we do Friday at noon instead?', 10),
    them('👍', 11)
  ];
  assert.match(findMeetingProposal(chat).text, /Friday/);
});

check('"come over this weekend" from the other party qualifies', () => {
  assert.ok(isMeetingProposalText('Should I swing by my parents house to water the plants this weekend?'));
  assert.ok(isMeetingProposalText('Are you around tomorrow morning? Could come over'));
  assert.ok(!isMeetingProposalText('Good you went to the doctor. Is the x ray done?'));
  assert.ok(!isMeetingProposalText('Cool'));
});

check('unansweredTail returns only what follows Ben’s last message', () => {
  const chat = [them('a', 8), me('b', 9), them('c', 10), them('d', 11)];
  assert.deepStrictEqual(unansweredTail(chat).map(m => m.text), ['c', 'd']);
  assert.deepStrictEqual(unansweredTail([them('a', 8), me('b', 9)]), []);
});

console.log(`\n${passed} checks passed`);
