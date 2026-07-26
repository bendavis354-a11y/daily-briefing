/**
 * Checks for task auto-completion, retention/linger, and reply-pattern learning.
 * Run: node src/tasks.test.mjs
 */
import assert from 'node:assert';
import {
  carryForwardTasks, applyReplyCompletions, retainTasks,
  extractReplyObservations, updatePatterns
} from './tasks.mjs';

const DAY = 24 * 3600 * 1000;
const NOW = new Date('2026-07-26T20:30:00Z');
const iso = daysAgo => new Date(NOW - daysAgo * DAY).toISOString();
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

// ── auto-completion ──────────────────────────────────────────────────────────
const convoRepliedAfter = {
  conversationKey: '<maya@x>',
  latestMessage: { fromMe: true, internalDate: NOW - 2 * 3600 * 1000, sourceAccount: 'ben@heartspringgardens.org' }
};
const convoRepliedBefore = {
  conversationKey: '<old@x>',
  latestMessage: { fromMe: true, internalDate: NOW - 9 * DAY }
};
const convoTheyAnswered = {
  conversationKey: '<ari@x>',
  latestMessage: { fromMe: false, internalDate: NOW - 3600 * 1000 }
};

check('task completes when Ben replied after it was raised', () => {
  const tasks = [{ id: 't1', conversationKey: '<maya@x>', status: 'open', addedAt: iso(2) }];
  applyReplyCompletions(tasks, [convoRepliedAfter], NOW);
  assert.strictEqual(tasks[0].status, 'completed');
  assert.strictEqual(tasks[0].completedBy, 'reply');
  assert.ok(tasks[0].completedAt && tasks[0].detectedAt);
});

check('task does NOT complete when the reply predates the task', () => {
  const tasks = [{ id: 't2', conversationKey: '<old@x>', status: 'open', addedAt: iso(2) }];
  applyReplyCompletions(tasks, [convoRepliedBefore], NOW);
  assert.strictEqual(tasks[0].status, 'open');
});

check('task does NOT complete when the other party spoke last', () => {
  const tasks = [{ id: 't3', conversationKey: '<ari@x>', status: 'open', addedAt: iso(2) }];
  applyReplyCompletions(tasks, [convoTheyAnswered], NOW);
  assert.strictEqual(tasks[0].status, 'open');
});

check('task with no conversation in scan stays open', () => {
  const tasks = [{ id: 't4', conversationKey: '<gone@x>', status: 'open', addedAt: iso(20) }];
  applyReplyCompletions(tasks, [convoRepliedAfter], NOW);
  assert.strictEqual(tasks[0].status, 'open');
});

// ── carry-forward + retention ────────────────────────────────────────────────
check('completed tasks carry forward without the carriedForward flag', () => {
  const merged = carryForwardTasks(
    [{ id: 'new', text: 'today' }],
    [{ id: 'done', status: 'completed', addedAt: iso(3) }, { id: 'open', addedAt: iso(5) }]
  );
  const done = merged.find(t => t.id === 'done');
  const open = merged.find(t => t.id === 'open');
  assert.ok(done && !done.carriedForward);
  assert.ok(open?.carriedForward);
});

check('completed task lingers one day past detection, then drops', () => {
  const fresh = { id: 'a', status: 'completed', detectedAt: iso(0.5), completedAt: iso(3) };
  const stale = { id: 'b', status: 'completed', detectedAt: iso(2), completedAt: iso(2) };
  const kept = retainTasks([fresh, stale], NOW);
  assert.deepStrictEqual(kept.map(t => t.id), ['a'], 'linger anchored to detection, not the reply date');
});

check('open task retention unchanged (45 days)', () => {
  const kept = retainTasks([{ id: 'x', addedAt: iso(44) }, { id: 'y', addedAt: iso(46) }], NOW);
  assert.deepStrictEqual(kept.map(t => t.id), ['x']);
});

// ── reply observation + patterns ─────────────────────────────────────────────
const fullConvo = {
  conversationKey: '<maya@x>',
  messages: [
    { fromMe: false, from: 'Maya Fields <maya@example.com>', internalDate: NOW - 26 * 3600 * 1000 },
    { fromMe: true, from: 'ben@heartspringgardens.org', internalDate: NOW - 2 * 3600 * 1000, sourceAccount: 'ben@heartspringgardens.org' }
  ]
};

check('observation extracted with correspondent + latency', () => {
  const obs = extractReplyObservations([fullConvo, convoTheyAnswered]);
  assert.strictEqual(obs.length, 1);
  assert.strictEqual(obs[0].correspondent, 'maya@example.com');
  assert.strictEqual(obs[0].name, 'Maya Fields');
  assert.strictEqual(Math.round(obs[0].latencyMs / 3600000), 24, '24h latency');
});

check('patterns fold in and compute average', () => {
  const obs = extractReplyObservations([fullConvo]);
  let p = updatePatterns(undefined, obs, NOW);
  const m = p.correspondents['maya@example.com'];
  assert.strictEqual(m.replies, 1);
  assert.strictEqual(m.avgReplyHours, 24);
  assert.strictEqual(m.name, 'Maya Fields');
});

check('same reply observed on a later run is not double-counted', () => {
  const obs = extractReplyObservations([fullConvo]);
  let p = updatePatterns(undefined, obs, NOW);
  p = updatePatterns(p, obs, NOW); // next day, same sent mail still in the 14d window
  assert.strictEqual(p.correspondents['maya@example.com'].replies, 1);
});

check('a NEWER reply from the same correspondent IS counted and average moves', () => {
  const obs1 = extractReplyObservations([fullConvo]);
  let p = updatePatterns(undefined, obs1, NOW);
  const later = {
    conversationKey: '<maya2@x>',
    messages: [
      { fromMe: false, from: 'Maya Fields <maya@example.com>', internalDate: NOW.getTime() + 1 * DAY },
      { fromMe: true, from: 'ben@heartspringgardens.org', internalDate: NOW.getTime() + 1 * DAY + 12 * 3600 * 1000 }
    ]
  };
  p = updatePatterns(p, extractReplyObservations([later]), NOW);
  const m = p.correspondents['maya@example.com'];
  assert.strictEqual(m.replies, 2);
  assert.strictEqual(m.avgReplyHours, 18, '(24h + 12h) / 2');
});

console.log(`\n${passed} checks passed.`);
