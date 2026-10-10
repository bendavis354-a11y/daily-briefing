/**
 * Action-item lifecycle + reply-pattern observation.
 *
 * Tasks persist in state until completed. Completion happens two ways:
 *   - manually, in the page (browser localStorage; invisible to the pipeline)
 *   - automatically, when the sent-mail scan shows Ben replied on the task's
 *     conversation AFTER the task was raised (`completedBy: 'reply'`)
 * Auto-completed tasks linger for one day under "Recently completed" before
 * being purged, so Ben sees the system noticed his reply.
 *
 * Reply patterns: each observed Ben-reply (correspondent, latency from their
 * message to his answer) is folded into a per-correspondent profile in state,
 * giving the analysis step grounded context about his habits — e.g. flagging
 * silence that is unusual for a correspondent he normally answers quickly.
 */

const DAY_MS = 24 * 3600 * 1000;

/**
 * When a task was raised. Tasks are only stamped with `addedAt` once they are
 * persisted (run-state-update), so a task raised in the current run has none —
 * it is new, i.e. `now`.
 *
 * The subtlety this guards: `Date.parse(t.addedAt || 0)` reads as "epoch when
 * absent" but Date.parse takes a *string*, so 0 stringifies to "0" and parses
 * as the year 2000. Every unstamped task therefore looked 26 years old, and
 * retainTasks dropped all of them — which silently emptied the action-items
 * checklist for both email and iMessage todos.
 */
function taskAddedAt(task, now) {
  const parsed = Date.parse(task?.addedAt || '');
  return Number.isNaN(parsed) ? now.getTime() : parsed;
}

/** Merge prior tasks (any status) ahead of today's freshly raised todos, oldest first. */
export function carryForwardTasks(todayTodos, priorTasks) {
  const ids = new Set(todayTodos.map(t => t.id).filter(Boolean));
  const carried = [];
  for (const prior of priorTasks || []) {
    if (!prior.id || ids.has(prior.id)) continue;
    ids.add(prior.id);
    carried.push(prior.status === 'completed' ? { ...prior } : { ...prior, carriedForward: true });
  }
  carried.sort((a, b) => String(a.addedAt || '').localeCompare(String(b.addedAt || '')));
  return [...carried, ...todayTodos];
}

/**
 * Collapse tasks that ask for the same thing.
 *
 * One message can reach the pipeline twice — the Workspace copy over OAuth and
 * the personal-mailbox copy via the connector — and when their snippets differ
 * the content key does not match, so they stay separate conversations and each
 * raises its own todo. Cross-account identity is the deeper question; the
 * checklist just must never show one ask twice. First occurrence wins, so a
 * carried-forward task (with its addedAt and age) outranks a fresh duplicate.
 */
export function dedupeTasks(tasks) {
  const seen = new Set();
  const out = [];
  for (const t of tasks || []) {
    const key = String(t?.text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Auto-complete open tasks whose conversation's latest message is from Ben and
 * postdates the task. Mutates and returns the task list.
 */
export function applyReplyCompletions(tasks, conversations, now = new Date()) {
  const byKey = new Map();
  for (const c of conversations || []) byKey.set(c.conversationKey, c);
  for (const t of tasks) {
    if (t.status === 'completed' || !t.conversationKey) continue;
    const latest = byKey.get(t.conversationKey)?.latestMessage;
    if (!latest?.fromMe || !latest.internalDate) continue;
    const added = taskAddedAt(t, now);
    if (latest.internalDate <= added) continue; // reply predates the ask
    t.status = 'completed';
    t.completedAt = new Date(latest.internalDate).toISOString();
    t.completedBy = 'reply';
    t.detectedAt = now.toISOString();
  }
  return tasks;
}

/**
 * Retention policy: open tasks live 45 days; completed tasks linger one day
 * past DETECTION (not past the reply itself, so a reply found today still
 * gets its day on the page), then drop. Capped to bound state growth.
 *
 * Text asks get 14 days, not 45. They auto-complete only while their chat is
 * inside the export's rolling window, so one older than that can never close
 * on its own, and a two-week-old "reply to this text" is no longer actionable.
 *
 * Over the cap, what to keep is decided by rank, never by position. The list
 * arrives oldest-first (carryForwardTasks puts prior tasks ahead so dedupe
 * keeps their original date), and a plain slice therefore dropped every task
 * raised today once the list filled: on 10/09 the newest of its 59 items was
 * from 10/03, and every text ask and follow-up raised since had been dropped.
 */
export function retainTasks(tasks, now = new Date(), { openMaxDays = 45, textMaxDays = 14, completedLingerDays = 1, cap = 60 } = {}) {
  const out = [];
  for (const t of tasks || []) {
    if (t.status === 'completed') {
      const anchor = Date.parse(t.detectedAt || t.completedAt || 0);
      if (anchor && now - anchor > completedLingerDays * DAY_MS) continue;
    } else {
      const added = taskAddedAt(t, now);
      const maxDays = t.origin === 'imessage' ? textMaxDays : openMaxDays;
      if (now - added > maxDays * DAY_MS) continue;
    }
    out.push(t);
  }
  if (out.length <= cap) return out;

  // Open before completed, then priority, then newest; ties keep list order.
  const PRIORITY = { high: 0, medium: 1, low: 2 };
  const keep = new Set(
    out.map((t, i) => ({ t, i }))
      .sort((a, b) =>
        (a.t.status === 'completed') - (b.t.status === 'completed') ||
        (PRIORITY[a.t.priority] ?? 1) - (PRIORITY[b.t.priority] ?? 1) ||
        taskAddedAt(b.t, now) - taskAddedAt(a.t, now) ||
        a.i - b.i)
      .slice(0, cap)
      .map(x => x.i)
  );
  return out.filter((_, i) => keep.has(i));
}

/**
 * Extract Ben-reply observations from full conversations (must carry message
 * lists with fromMe/internalDate/from): for each conversation whose latest
 * message is Ben's, find the preceding other-party message and measure latency.
 */
export function extractReplyObservations(conversations) {
  const out = [];
  for (const c of conversations || []) {
    const msgs = c.messages || [];
    const latest = msgs[msgs.length - 1];
    if (!latest?.fromMe || !latest.internalDate) continue;
    let prev = null;
    for (let i = msgs.length - 2; i >= 0; i--) {
      if (!msgs[i].fromMe) { prev = msgs[i]; break; }
    }
    if (!prev?.internalDate) continue;
    const { name, email } = parseAddress(prev.from);
    if (!email) continue;
    out.push({
      conversationKey: c.conversationKey,
      correspondent: email,
      name,
      repliedAt: new Date(latest.internalDate).toISOString(),
      latencyMs: latest.internalDate - prev.internalDate,
      account: latest.sourceAccount || ''
    });
  }
  return out;
}

/**
 * Fold reply observations into the persistent per-correspondent profile.
 * Idempotent per correspondent via the lastReplyAt guard, so re-observing the
 * same reply on consecutive runs does not double-count. Pruned by recency.
 */
export function updatePatterns(patterns, observations, now = new Date(), { cap = 100 } = {}) {
  const next = { correspondents: { ...(patterns?.correspondents || {}) }, updatedAt: now.toISOString() };
  for (const obs of observations || []) {
    const prior = next.correspondents[obs.correspondent];
    if (prior?.lastReplyAt && obs.repliedAt <= prior.lastReplyAt) continue; // already counted
    const replies = (prior?.replies || 0) + 1;
    const totalLatencyMs = (prior?.totalLatencyMs || 0) + obs.latencyMs;
    next.correspondents[obs.correspondent] = {
      name: obs.name || prior?.name || '',
      replies,
      totalLatencyMs,
      avgReplyHours: Math.round(totalLatencyMs / replies / 3600000 * 10) / 10,
      lastReplyAt: obs.repliedAt,
      lastAccount: obs.account || prior?.lastAccount || ''
    };
  }
  const entries = Object.entries(next.correspondents)
    .sort(([, a], [, b]) => String(b.lastReplyAt || '').localeCompare(String(a.lastReplyAt || '')))
    .slice(0, cap);
  next.correspondents = Object.fromEntries(entries);
  return next;
}

function parseAddress(from) {
  const s = String(from || '');
  const m = s.match(/^"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  const bare = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+/i);
  return { name: '', email: bare ? bare[0].toLowerCase() : '' };
}
