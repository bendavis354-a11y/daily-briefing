/**
 * Render the daily briefing as a formal briefing document.
 *
 * Format follows established briefing conventions — President's Daily Brief
 * (short numbered items, each present because it merits attention or ties to an
 * upcoming decision) and BLUF memo structure (bottom line first, compressed
 * background, supporting detail relegated to an appendix):
 *
 *   OVERVIEW         — the bottom line (1–3 sentence BLUF plus key points)
 *                       beside a seven-day calendar card: the week from today,
 *                       tomorrow emphasised because the brief is read in the
 *                       evening; multi-day all-day events shown as spans
 *   1. BOTTOM LINE   — inside the overview
 *   2. PRIORITY ITEMS — numbered; Background / Development / Assessment /
 *                       Action; status + account designators; thread link
 *   3. ACTION ITEMS  — persistent checklist; items carry forward across days
 *                       and are checked off in the page (localStorage)
 *   4. CORRESPONDENCE REQUIRING RESPONSE — exhaustive list of threads awaiting
 *                       a reply, oldest first; derived from the scan (not from
 *                       the analysis step) so nothing can be dropped by
 *                       editorial judgment; newsletters and spam excluded
 *   5. PROPOSED CALENDAR ENTRIES — only when the scan proposed any
 *   6. OTHER DEVELOPMENTS — one-line items
 *   7. ROUTINE TRAFFIC — one-line disposition of the compressed mass
 *   Appendix         — full categorized traffic, collapsed
 *
 * Sections after the first are numbered in the order they render, so an
 * omitted section never leaves a gap.
 *
 * No reply drafting anywhere: every item links to the source thread; Ben
 * composes his own responses. Reads briefing.json (facts + `brief` written by
 * the routine's analysis step), validates, writes dist/briefing.plain.html.
 */
import fs from 'node:fs';
import Ajv from 'ajv/dist/2020.js';

const briefingPath = process.env.BRIEFING_JSON || 'briefing.json';
const outPath = process.env.PLAIN_BRIEFING_HTML || 'dist/briefing.plain.html';

const briefing = JSON.parse(fs.readFileSync(briefingPath, 'utf8'));
const schema = JSON.parse(fs.readFileSync('schemas/briefing.schema.json', 'utf8'));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

if (!validate(briefing)) {
  console.error('Briefing failed validation:');
  console.error(JSON.stringify(validate.errors, null, 2));
  process.exit(1);
}

const meta = briefing.metadata || {};
const sections = briefing.sections || {};
const brief = briefing.brief || null;
const TZ = meta.timezone || 'America/New_York';
const todayISO = localISODate(new Date(), TZ);
const isStale = meta.date !== todayISO;

// ── account designators ──────────────────────────────────────────────────────
const ACCOUNT_META = {};
for (const a of briefing.accounts || []) {
  const email = (a.email || '').toLowerCase();
  let cls = 'tag-other';
  if (email.includes('biodynamics')) cls = 'tag-bda';
  else if (email.includes('heartspring')) cls = 'tag-hs';
  else if (email) cls = 'tag-personal';
  ACCOUNT_META[email] = { label: (a.label || a.email || '').toUpperCase(), cls };
}
function acct(email) {
  const key = String(email || '').toLowerCase();
  if (ACCOUNT_META[key]) return ACCOUNT_META[key];
  const e = String(email || '');
  if (e.includes('biodynamics')) return { label: 'BIODYNAMICS', cls: 'tag-bda' };
  if (e.includes('heartspring')) return { label: 'HEARTSPRING', cls: 'tag-hs' };
  if (e.includes('gmail')) return { label: 'PERSONAL', cls: 'tag-personal' };
  return { label: e.toUpperCase() || '—', cls: 'tag-other' };
}
function acctTag(email) {
  if (!email) return '';
  const { label, cls } = acct(email);
  return `<span class="tag ${cls}">${esc(label)}</span>`;
}

// Calendar links open in Ben's personal Google account: authuser pins the
// account so "Add to calendar" always lands on his own calendar.
const PERSONAL_ACCOUNT = (briefing.accounts || []).find(a =>
  String(a.type || '').toLowerCase() === 'personal' || String(a.email || '').includes('gmail')
)?.email || '';

// ── status designators ───────────────────────────────────────────────────────
const STATUS = {
  action_required: { label: 'ACTION REQUIRED', cls: 'st-action' },
  awaiting_reply: { label: 'AWAITING REPLY', cls: 'st-await' },
  monitoring: { label: 'MONITORING', cls: 'st-monitor' },
  new: { label: 'NEW', cls: 'st-new' },
  resolved: { label: 'RESOLVED', cls: 'st-resolved' }
};
function statusTag(s) {
  const st = STATUS[s] || STATUS.monitoring;
  return `<span class="tag ${st.cls}">${st.label}</span>`;
}

// ── links (open-thread + calendar only; no compose, nothing auto-sends) ──────
function threadLink(account, threadId) {
  if (!threadId) return '';
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account || '')}#all/${encodeURIComponent(threadId)}`;
}
function calendarTemplateLink({ title, start, end, details, location }) {
  const p = new URLSearchParams({ action: 'TEMPLATE', text: title || 'New event' });
  if (PERSONAL_ACCOUNT) p.set('authuser', PERSONAL_ACCOUNT);
  const s = calStamp(start);
  const e = calStamp(end) || s;
  if (s) p.set('dates', `${s}/${e}`);
  if (details) p.set('details', details);
  if (location) p.set('location', location);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}
function calStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
function extA(href, cls, label) {
  return `<a class="${cls}" href="${escAttr(href)}" target="_blank" rel="noopener">${label}</a>`;
}

// ── document sections ────────────────────────────────────────────────────────
function masthead() {
  const dateLine = meta.todayLabel || meta.date;
  const srcCount = (briefing.accounts || []).length;
  return `
  <header class="masthead">
    <div class="mast-title">DAILY BRIEFING</div>
    <div class="mast-meta">
      <span>${esc(dateLine)}</span>
      <span>Prepared ${esc(fmtTime(meta.generatedAt))} ET</span>
      <span>Sources: ${srcCount} mail accounts · calendars · messages</span>
    </div>
  </header>`;
}

/**
 * One strip for the two page controls: the live-facts state with its button on
 * the left, the account filter on the right. They used to be two stacked bars;
 * neither is content, so they share a line and stay out of the document's way.
 */
function utilityBar() {
  const btns = (briefing.accounts || []).map(a => {
    const { label, cls } = acct(a.email);
    return `<button class="tag ${cls} filter-btn" data-account="${escAttr((a.email || '').toLowerCase())}" onclick="filterAccount(this)">${esc(label)}</button>`;
  }).join('');
  return `
  <div class="utility">
    <div class="refresh-bar" id="refresh-bar">
      <span class="rb-state" id="rb-state">Facts as written, ${esc(fmtTime(meta.generatedAt))} ET</span>
      <button type="button" class="rb-btn" id="rb-btn" onclick="refreshFacts()">Check for updates</button>
    </div>
    <nav class="filterbar" role="group" aria-label="Filter by account">
      <button class="tag tag-other filter-btn active" data-account="all" onclick="filterAccount(this)">ALL</button>${btns}
    </nav>
  </div>`;
}

// Section numbers are handed out in render order, only to sections that
// actually render, so the document never shows "5." followed by "7.".
let sectionCount = 1; // the bottom line is always 1
function nextSection() { return ++sectionCount; }

/**
 * The overview: bottom line on the left, the week's calendar on the right.
 * Side by side because they answer the same question from two directions —
 * what matters, and when it falls due.
 */
function overview() {
  const b = brief || fallbackBrief();
  return `
  <section class="overview">
    <div class="ov-bluf">
      <h2 class="sec-label">1. Bottom line</h2>
      <p class="bluf">${esc(b.bottomLine)}</p>
      ${b.keyPoints?.length ? `<ul class="keypoints">${b.keyPoints.map(k => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
    </div>
    ${calendarCard()}
  </section>`;
}

// ── calendar card ────────────────────────────────────────────────────────────
// Seven days from today, one row per day. The scan's week window starts today
// and runs six days ahead, so the card covers exactly what was gathered. The
// focus day (tomorrow, for an evening read) is highlighted; today's row is
// dimmed since its commitments are behind him by the time he opens this.
const FOCUS_OFFSET = process.env.BRIEFING_SCHEDULE_DAY === 'today' ? 0 : 1;

function addDaysISO(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function eventDayISO(ev) {
  const s = String(ev.start || '');
  if (ev.allDay || /^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(d) ? '' : localISODate(d, TZ);
}
// All-day events carry an exclusive end date; a two-day event ends the day
// after its last day. Anything longer than one day is drawn as a span.
function allDaySpan(ev) {
  if (!ev.allDay) return null;
  const start = String(ev.start || '').slice(0, 10);
  const end = String(ev.end || '').slice(0, 10);
  if (!start || !end) return null;
  const last = addDaysISO(end, -1);
  return last > start ? { start, last } : null;
}
function fmtShortDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(d);
}
function weekdayShort(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(d);
}
// Events are coloured by the account they belong to when the calendar is one
// of Ben's mailboxes, so the card reads with the same designators as the rest
// of the document; imported calendars keep their own Google colour.
function eventColor(ev) {
  const id = String(ev.calendarId || ev.calendarName || '').toLowerCase();
  if (id.includes('biodynamics')) return 'var(--bda)';
  if (id.includes('heartspring')) return 'var(--hs)';
  if (id.includes('gmail')) return 'var(--pers)';
  return ev.color || 'var(--rule)';
}

function calendarCard() {
  const base = meta.date || todayISO;
  const days = Array.from({ length: 7 }, (_, i) => addDaysISO(base, i));
  const weekEnd = days[6];
  const focus = days[FOCUS_OFFSET];
  const events = [...(sections.weekSchedule || [])];
  // Tomorrow's list is gathered separately; fold it in for the morning mode
  // or for any day the week scan missed.
  for (const ev of sections.tomorrowSchedule || []) {
    if (!events.find(e => e.title === ev.title && e.start === ev.start)) events.push(ev);
  }

  const spans = [];
  const byDay = new Map(days.map(d => [d, []]));
  for (const ev of events) {
    const span = allDaySpan(ev);
    if (span) {
      if (span.last >= base && span.start <= weekEnd) spans.push({ ev, ...span });
      continue;
    }
    const day = eventDayISO(ev);
    if (byDay.has(day)) byDay.get(day).push(ev);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => (a.allDay === b.allDay ? String(a.start).localeCompare(String(b.start)) : a.allDay ? -1 : 1));
  }
  const total = [...byDay.values()].reduce((n, l) => n + l.length, 0);

  const spanRows = spans.map(s => {
    const from = s.start < base ? '' : `from ${fmtShortDate(s.start)}`;
    const to = s.last > weekEnd ? `through ${fmtShortDate(s.last)}` : `to ${fmtShortDate(s.last)}`;
    const when = [from, to].filter(Boolean).join(', ') || 'all week';
    const startCol = Math.max(0, days.indexOf(s.start));
    const endCol = s.last > weekEnd ? 6 : days.indexOf(s.last);
    const inner = `<span class="cal-span-bar" style="--from:${startCol};--to:${endCol + 1};border-color:${escAttr(eventColor(s.ev))}"></span>
      <span class="cal-span-text"><strong>${esc(s.ev.title)}</strong> <span class="cal-when">${esc(when)}</span></span>`;
    return `<div class="cal-span">${s.ev.htmlLink ? `<a class="cal-span-link" href="${escAttr(s.ev.htmlLink)}" target="_blank" rel="noopener">${inner}</a>` : inner}</div>`;
  }).join('');

  const dayRows = days.map((d, i) => {
    const list = byDay.get(d);
    const isFocus = d === focus;
    const isToday = i === 0 && !isFocus;
    const caption = isFocus ? (FOCUS_OFFSET === 0 ? 'Today' : 'Tomorrow') : isToday ? 'Today' : '';
    const cls = ['cal-day', isFocus ? 'is-focus' : '', isToday ? 'is-past' : ''].filter(Boolean).join(' ');
    return `
      <div class="${cls}">
        <div class="cal-date">
          <span class="cal-wd">${esc(weekdayShort(d))}</span>
          <span class="cal-num">${Number(d.slice(8, 10))}</span>
          ${caption ? `<span class="cal-cap">${caption}</span>` : ''}
        </div>
        <div class="cal-events">
          ${list.length ? list.map(calEvent).join('') : '<span class="cal-empty">—</span>'}
        </div>
      </div>`;
  }).join('');

  return `
    <aside class="ov-cal" aria-label="Calendar for the week">
      <div class="cal-head">
        <span class="sec-label cal-title">Calendar</span>
        <span class="cal-range">${esc(fmtShortDate(base))} – ${esc(fmtShortDate(weekEnd))} · ${total} commitment${total === 1 ? '' : 's'}</span>
      </div>
      ${spanRows ? `<div class="cal-spans">${spanRows}</div>` : ''}
      <div class="cal-days">${dayRows}</div>
    </aside>`;
}

// A location that is a meeting URL is shown as its host ("zoom.us"): the chip
// already opens the event, where the full link lives, and a raw URL would
// swamp the column.
function shortLocation(loc) {
  const s = String(loc || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return s;
  try { return new URL(s).hostname.replace(/^(www|us\d+web)\./, ''); } catch { return 'link'; }
}

function calEvent(ev) {
  const time = ev.allDay ? 'All day' : fmtTime(ev.start);
  const end = !ev.allDay && ev.end ? fmtTime(ev.end) : '';
  const loc = shortLocation(ev.location);
  const inner = `
      <span class="cal-time">${esc(time)}${end ? `<span class="cal-end">–${esc(end)}</span>` : ''}</span>
      <span class="cal-body"><span class="cal-name">${esc(ev.title)}</span>${loc ? `<span class="cal-loc">${esc(loc)}</span>` : ''}</span>`;
  const style = `style="border-color:${escAttr(eventColor(ev))}"`;
  return ev.htmlLink
    ? `<a class="cal-ev" ${style} href="${escAttr(ev.htmlLink)}" target="_blank" rel="noopener" title="Open in Google Calendar">${inner}</a>`
    : `<div class="cal-ev" ${style}>${inner}</div>`;
}

// Priority items in presentation order, plus a lookup from conversation key to
// the item number they appear as — so the response queue can cross-reference
// rather than silently repeat them.
const orderedItems = [...((brief || fallbackBrief()).items || [])]
  .sort((x, y) => (y.priority || 3) - (x.priority || 3));
const itemNumberByKey = new Map();
orderedItems.forEach((item, i) => {
  for (const key of item.conversationKeys || []) itemNumberByKey.set(key, i + 1);
});

// Conversation key → Gmail thread, so action items carried forward from earlier
// runs can still link back to their source thread.
const threadIdByKey = new Map();
const threadAccountByKey = new Map();
for (const list of Object.values(sections)) {
  if (!Array.isArray(list)) continue;
  for (const it of list) {
    const key = it?.conversationKey;
    const tid = it?.viewThreadId || it?.gmailThreadId;
    if (key && tid && !threadIdByKey.has(key)) {
      threadIdByKey.set(key, tid);
      threadAccountByKey.set(key, it.viewThreadAccount || it.account || '');
    }
  }
}

function priorityItems() {
  if (!orderedItems.length) return '';
  return `
  <section class="doc-sec">
    <h2 class="sec-label">${nextSection()}. Priority items</h2>
    <ol class="items">${orderedItems.map(itemBlock).join('')}</ol>
  </section>`;
}

/**
 * Action items, as a checklist.
 *
 * Items persist across days: the pipeline carries open tasks forward until they
 * are completed. Completion is recorded in the browser (localStorage) keyed by
 * the task's stable id, so a checked item stays checked across reloads and
 * across daily republishes of the page. Completed items are hidden behind a
 * "show completed" toggle rather than deleted.
 */
function actionItems() {
  const todos = sections.todos || [];
  if (!todos.length) return '';
  const byPriThenAge = (a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    const d = (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1);
    if (d) return d;
    return String(a.addedAt || '').localeCompare(String(b.addedAt || ''));
  };
  const open = todos.filter(t => t.status !== 'completed').sort(byPriThenAge);
  // Auto-completed by a detected reply; linger on the page for one day so Ben
  // sees the system registered his response.
  const done = todos.filter(t => t.status === 'completed')
    .sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
  return `
  <section class="doc-sec">
    <h2 class="sec-label">${nextSection()}. Action items — <span id="task-open-count">${open.length}</span> open</h2>
    <p class="sec-note">Checked items clear; your replies, by email or text, check items automatically. <button type="button" class="link-btn" id="task-toggle" onclick="toggleCompleted()">Show completed</button></p>
    <ul class="tasks hide-done" id="task-list">
      ${open.map(taskRow).join('')}
      ${done.length ? `<li class="tasks-subhead">Recently completed</li>${done.map(completedRow).join('')}` : ''}
    </ul>
  </section>`;
}

function completedRow(t, i) {
  const id = t.id || `ctask-${i}`;
  const when = t.completedAt ? fmtDay(t.completedAt) : '';
  const note = t.completedBy === 'reply'
    ? `Completed — your reply${when ? ` on ${when}` : ''} closed this out`
    : `Completed${when ? ` ${when}` : ''}`;
  return `<li class="task done auto" data-account="${escAttr((t.account || '').toLowerCase())}" data-task-id="${escAttr(id)}">
    <input type="checkbox" class="t-check" checked disabled>
    <span class="t-label">
      <span class="t-text">${esc(t.text || '')}</span>
      <span class="t-sub">${esc([t.account ? acct(t.account).label : '', note].filter(Boolean).join(' · '))}</span>
    </span>
  </li>`;
}

function fmtDay(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(d);
}

function taskRow(t, i) {
  const id = t.id || `task-${i}`;
  const domId = `task-${i}`;
  const pri = String(t.priority || 'medium').toLowerCase();
  const priCls = pri === 'high' ? 't-hi' : pri === 'low' ? 't-lo' : 't-md';
  const href = t.conversationKey && threadIdByKey.get(t.conversationKey)
    ? threadLink(threadAccountByKey.get(t.conversationKey) || t.account, threadIdByKey.get(t.conversationKey))
    : '';
  const age = t.addedAt ? outstandingLabel(Date.parse(t.addedAt)) : '';
  const meta = [
    t.account ? acct(t.account).label : '',
    age ? `outstanding ${age}` : '',
    t.origin === 'imessage' ? 'from messages' : ''
  ].filter(Boolean).join(' · ');
  // The excerpt is the only surviving trace of a text once it ages out of the
  // export window, so it is rendered even when the message itself is long gone.
  const ctx = String(t.context || '').trim();
  return `<li class="task" data-account="${escAttr((t.account || '').toLowerCase())}" data-task-id="${escAttr(id)}"
      data-convkey="${escAttr(t.conversationKey || '')}">
    <input type="checkbox" class="t-check" id="${domId}" data-task-id="${escAttr(id)}" onchange="toggleTask(this)">
    <label class="t-label" for="${domId}">
      <span class="t-pri ${priCls}">${esc(pri)}</span>
      <span class="t-text">${esc(t.text || '')}</span>
      ${ctx ? `<span class="t-ctx">${esc(ctx)}</span>` : ''}
      <span class="t-sub">${esc(meta)}</span>
    </label>
    ${href ? extA(href, 'doc-link', 'Open thread →') : ''}
  </li>`;
}

function outstandingLabel(ts) {
  if (!ts) return '';
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return 'since today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

/**
 * Complete list of correspondence awaiting a reply from Ben.
 *
 * Derived from the scan rather than from the analysis step, so it is exhaustive
 * by construction — no thread can be dropped by editorial judgment. Draws only
 * from the substantive categories (urgent, business, personal, financial);
 * newsletters and spam are excluded by construction. Ordered oldest-first, so
 * the threads that have been waiting longest surface at the top.
 */
function responseQueue() {
  const pools = [sections.urgent, sections.business, sections.personal, sections.financial];
  const seen = new Set();
  const awaiting = [];   // he has never replied in the thread
  const continued = [];  // he replied; others have since carried on without him
  for (const list of pools) {
    for (const it of list || []) {
      if (it.status !== 'waiting_on_ben' && it.status !== 'thread_continued') continue;
      const key = it.conversationKey || `${it.sender || ''}|${it.subject || ''}`;
      // One thread reaching two mailboxes survives as two conversations with
      // different keys. Listing it twice is the same nag twice over, so collapse
      // on subject as well. Short subjects keep their own key, since "Hi" and
      // "Thanks" collide across unrelated threads.
      const subject = String(it.subject || '').toLowerCase()
        .replace(/^((re|fwd?|fw)\s*:\s*)+/i, '').trim();
      const dedupeKey = subject.length >= 8 ? `subj:${subject}` : key;
      if (seen.has(key) || seen.has(dedupeKey)) continue;
      seen.add(key);
      seen.add(dedupeKey);
      const row = { ...it, _key: key, _ts: Date.parse(it.date || '') || null };
      (it.status === 'thread_continued' ? continued : awaiting).push(row);
    }
  }

  const oldestFirst = (a, b) => {
    if (a._ts && b._ts) return a._ts - b._ts;
    if (a._ts) return -1;
    if (b._ts) return 1;
    return 0;
  };
  awaiting.sort(oldestFirst);
  continued.sort(oldestFirst);

  if (!awaiting.length && !continued.length) {
    return `
  <section class="doc-sec">
    <h2 class="sec-label">${nextSection()}. Correspondence requiring response</h2>
    <p class="none">No threads are currently awaiting a reply.</p>
  </section>`;
  }

  // Split rather than suppressed. This section's value is that nothing can be
  // lost from it, so a thread he has already answered is demoted and labelled,
  // never dropped — he can still see it, it just stops reading as an instruction.
  const continuedBlock = continued.length ? `
    <h3 class="queue-subhead">You have replied — the thread continued without you (${continued.length})</h3>
    <p class="sec-note">Group threads where your reply is already in and others have since written. No action implied.</p>
    <ul class="queue queue-muted">${continued.map(queueRow).join('')}</ul>` : '';

  const awaitingBlock = awaiting.length ? `
    ${continued.length ? '<h3 class="queue-subhead">Awaiting your first reply</h3>' : ''}
    <ul class="queue">${awaiting.map(queueRow).join('')}</ul>`
    : '<p class="none">Nothing is awaiting a first reply from you.</p>';

  return `
  <section class="doc-sec">
    <h2 class="sec-label">${nextSection()}. Correspondence requiring response — ${awaiting.length} thread${awaiting.length === 1 ? '' : 's'}</h2>
    <p class="sec-note">Threads awaiting your reply, oldest first.</p>
    ${awaitingBlock}
    ${continuedBlock}
  </section>`;
}

function queueRow(r) {
  const href = threadLink(r.viewThreadAccount || r.account, r.viewThreadId || r.gmailThreadId);
  const num = itemNumberByKey.get(r._key);
  const age = waitingLabel(r._ts);
  const subjKey = String(r.subject || '').toLowerCase()
    .replace(/^((re|fwd?|fw)\s*:\s*)+/i, '').trim();
  return `<li data-account="${escAttr((r.account || '').toLowerCase())}"
      data-convkey="${escAttr(r._key || '')}"
      data-subjkey="${escAttr(subjKey.length >= 8 ? subjKey : '')}"
      data-status="${escAttr(r.status || '')}">
    <div class="q-main">
      ${acctTag(r.account)}
      <span class="q-sender">${esc(r.senderName || r.sender || 'Unknown sender')}</span>
      <span class="q-subject">${esc(r.subject || '(no subject)')}</span>
    </div>
    <div class="q-meta">
      ${num ? `<span class="q-ref">See item ${num}</span>` : ''}
      ${age ? `<span class="q-age">${esc(age)}</span>` : ''}
      ${href ? extA(href, 'doc-link', 'Open thread →') : ''}
    </div>
  </li>`;
}

function waitingLabel(ts) {
  if (!ts) return '';
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

function itemBlock(item) {
  const email = (item.account || '').toLowerCase();
  const openHref = threadLink(item.viewThreadAccount || item.account, item.viewThreadId);
  const fields = [
    item.background ? field('Background', item.background) : '',
    field('Development', item.development),
    item.assessment ? field('Assessment', item.assessment) : ''
  ].join('');
  const action = item.action ? `
    <div class="action-line">
      <span class="action-label">Action${item.due ? ` — ${esc(item.due)}` : ''}</span>
      <span class="action-text">${esc(item.action)}</span>
    </div>` : '';
  const links = [
    openHref ? extA(openHref, 'doc-link', 'Open thread →') : '',
    item.calendarSuggestion ? extA(calendarTemplateLink(item.calendarSuggestion), 'doc-link', 'Add to calendar →') : ''
  ].filter(Boolean).join('');
  return `
  <li class="item" data-account="${escAttr(email)}">
    <div class="item-head">
      <h3 class="item-title">${esc(item.title)}</h3>
      <div class="item-tags">${acctTag(item.account)}${statusTag(item.status)}</div>
    </div>
    <div class="item-body">${fields}</div>
    ${action}
    ${links ? `<div class="item-links">${links}</div>` : ''}
  </li>`;
}

function field(label, text) {
  return `<p class="field"><span class="field-label">${label} —</span> ${esc(text)}</p>`;
}

// The week's commitments themselves live in the overview card at the top; this
// section keeps only what the scan proposed adding, each with a time picker
// and a link that opens a pre-filled Google Calendar form for Ben to confirm.
function proposedEntries() {
  const proposals = sections.calendarProposals || [];
  if (!proposals.length) return '';
  return `
  <section class="doc-sec">
    <h2 class="sec-label">${nextSection()}. Proposed calendar entries</h2>
    <p class="sec-note">Suggested by the scan from messages proposing to meet. Nothing is added until you confirm it in Calendar.</p>
    ${proposals.map(proposalRow).join('')}
  </section>`;
}

function proposalRow(p, i) {
  const id = `prop-${i}`;
  const start = p.start || defaultStart();
  const href = calendarTemplateLink({ title: p.title, start, end: p.end || '', details: p.context || p.detail, location: p.location });
  return `<div class="proposal" data-account="${escAttr((p.account || '').toLowerCase())}">
    <div class="proposal-line">${acctTag(p.account)}<strong>${esc(p.title)}</strong>${p.context ? ` — ${esc(p.context)}` : ''}</div>
    <div class="proposal-controls">
      <input type="datetime-local" id="${id}-start" value="${escAttr(toLocalInput(start))}" onchange="updateCalLink('${id}')">
      <a id="${id}-link" class="doc-link" href="${escAttr(href)}" target="_blank" rel="noopener"
         data-title="${escAttr(p.title || '')}" data-details="${escAttr(p.context || p.detail || '')}" data-location="${escAttr(p.location || '')}"
         onclick="addToSchedule('${id}')">Add to calendar →</a>
    </div>
  </div>`;
}

function otherDevelopments() {
  const list = brief?.otherDevelopments || [];
  if (!list.length) return '';
  return `
  <section class="doc-sec">
    <h2 class="sec-label">${nextSection()}. Other developments</h2>
    <ul class="devs">
      ${list.map(d => {
        const href = d.viewThreadId ? threadLink(d.viewThreadAccount || d.account, d.viewThreadId) : '';
        return `<li data-account="${escAttr((d.account || '').toLowerCase())}">${acctTag(d.account)} ${esc(d.text)}${href ? ` ${extA(href, 'doc-link', 'Open →')}` : ''}</li>`;
      }).join('')}
    </ul>
  </section>`;
}

function routineTraffic() {
  const rt = brief?.routineTraffic;
  const count = rt?.count ?? ((sections.newsletter?.length || 0) + (sections.spam?.length || 0));
  if (!count && !rt?.note) return '';
  return `
  <section class="doc-sec">
    <h2 class="sec-label">${nextSection()}. Routine traffic</h2>
    <p class="routine">${count} lower-priority messages processed${rt?.note ? ` — ${esc(rt.note)}` : '.'}</p>
  </section>`;
}

function appendix() {
  const groups = [
    ['Urgent', sections.urgent], ['Business', sections.business], ['Personal', sections.personal],
    ['Financial', sections.financial], ['Awaiting response', sections.waiting],
    ['Newsletters', sections.newsletter], ['Spam', sections.spam]
  ].filter(([, list]) => list?.length);
  const imsgs = (sections.imessage || []).filter(m => !String(m.id).includes('notice'));
  if (!groups.length && !imsgs.length) return '';
  const total = groups.reduce((n, [, l]) => n + l.length, 0);
  return `
  <section class="doc-sec appendix">
    <details><summary>Appendix — full categorized traffic (${total} threads${imsgs.length ? `, ${imsgs.length} message conversations` : ''})</summary>
      ${imsgs.length ? `<h3 class="subsec-label">Messages</h3><ul class="raw-list">${imsgs.map(m =>
        `<li><strong>${esc(m.sender)}</strong> — ${esc(m.summary)}${m.needsReply ? ' <span class="tag st-await">AWAITING REPLY</span>' : ''}</li>`).join('')}</ul>` : ''}
      ${groups.map(([name, list]) => `
      <h3 class="subsec-label">${name} (${list.length})</h3>
      <ul class="raw-list">
        ${list.map(it => {
          const href = it.viewThreadId || it.gmailThreadId ? threadLink(it.viewThreadAccount || it.account, it.viewThreadId || it.gmailThreadId) : '';
          return `<li data-account="${escAttr((it.account || '').toLowerCase())}">${acctTag(it.account)} <strong>${esc(it.senderName || it.sender || '')}</strong> — ${esc(it.subject || '')}${href ? ` ${extA(href, 'doc-link', 'Open →')}` : ''}</li>`;
        }).join('')}
      </ul>`).join('')}
    </details>
  </section>`;
}

function docFooter() {
  const s = briefing.stats || {};
  const tracked = brief?.items?.length || 0;
  return `
  <footer>
    <div>${s.emailsScanned ?? 0} messages · ${(briefing.accounts || []).length} accounts · ${tracked} items in coverage · ${esc(fmtTime(meta.generatedAt))} ET</div>
    <div>Nothing is sent or scheduled automatically; links open Gmail or Calendar for review.</div>
  </footer>`;
}

function staleWarning() {
  return `<div class="stale">NOTE — This briefing was prepared ${esc(meta.date)}; a more recent edition has not yet been produced. Details may be out of date.</div>`;
}

// ── fallback when the analysis step didn't run ───────────────────────────────
function fallbackBrief() {
  const urgent = sections.urgent || [];
  const waiting = sections.waiting || [];
  const replies = sections.suggestedReplies || [];
  const items = [...urgent.map(u => ({
    id: `fb-${u.conversationKey || u.subject}`, title: u.subject || 'Urgent thread',
    account: u.account, status: 'action_required', priority: 5,
    development: u.summary || u.snippet || '', action: 'Review and respond.',
    viewThreadAccount: u.viewThreadAccount || u.account, viewThreadId: u.viewThreadId || u.gmailThreadId
  })), ...replies.slice(0, 4).map(r => ({
    id: `fb-r-${r.conversationKey || r.subject}`, title: r.subject || `Message from ${r.senderName || r.senderEmail}`,
    account: r.account, status: 'action_required', priority: 4,
    development: r.detail || 'Awaiting your response.', action: 'Respond.',
    viewThreadAccount: r.viewThreadAccount || r.account, viewThreadId: r.viewThreadId || r.gmailThreadId
  }))].slice(0, 6);
  return {
    bottomLine: 'The analysis step did not run for this edition. Items below are the scanner’s unranked flags; full categorized traffic is in the appendix.',
    keyPoints: [],
    items,
    otherDevelopments: waiting.slice(0, 8).map(w => ({
      text: `Awaiting response from ${w.senderName || w.sender}: ${w.subject}`,
      account: w.account, viewThreadAccount: w.viewThreadAccount, viewThreadId: w.viewThreadId
    })),
    routineTraffic: null
  };
}

// ── page ─────────────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Briefing — ${esc(meta.date)}</title>
  <style>${css()}</style>
</head>
<body>
  <main class="doc">
    ${masthead()}
    ${isStale ? staleWarning() : ''}
    ${utilityBar()}
    ${overview()}
    ${priorityItems()}
    ${actionItems()}
    ${responseQueue()}
    ${proposedEntries()}
    ${otherDevelopments()}
    ${routineTraffic()}
    ${appendix()}
    ${docFooter()}
  </main>
  <script>${clientJs()}</script>
</body>
</html>`;

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync(outPath, html);
console.log(`Rendered ${outPath}${brief ? '' : ' (fallback mode — no brief present)'}`);

// ── utilities ────────────────────────────────────────────────────────────────
function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(v) { return esc(v).replace(/'/g, '&#39;'); }
function localISODate(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${o.year}-${o.month}-${o.day}`;
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(d);
}
function toLocalInput(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const o = Object.fromEntries(p.map(x => [x.type, x.value]));
  return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}`;
}
function defaultStart() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

// ── styles: restrained document typography ───────────────────────────────────
function css() {
  return `
:root {
  --paper:#FDFDFB; --ink:#1A1A18; --muted:#5C5C55; --rule:#C9C7BC; --rule-light:#E4E2D8;
  --action:#8A2E1E; --action-bg:#F7EEEA; --await:#2E4E7E; --await-bg:#EDF1F7;
  --monitor:#5C5C55; --monitor-bg:#EFEEE8; --new-c:#2F5D3A; --new-bg:#EBF1EC;
  --bda:#6E5518; --bda-bg:#F3EEDF; --hs:#2F5D3A; --hs-bg:#EBF1EC; --pers:#2E4E7E; --pers-bg:#EDF1F7;
  --focus-bg:#FBF6E6; --focus-rule:#E3D6AE;
  --sans:Helvetica,Arial,sans-serif;
}
* { box-sizing:border-box; margin:0; padding:0; }
body { background:#F2F1EC; color:var(--ink); font-family:Georgia,'Times New Roman',serif; font-size:15.5px; line-height:1.55; }
.doc { max-width:820px; margin:0 auto; background:var(--paper); min-height:100vh; padding:36px 48px 48px; border-left:1px solid var(--rule-light); border-right:1px solid var(--rule-light); }
@media (max-width:640px){ .doc { padding:24px 18px 40px; } }
a { color:var(--await); }

.masthead { text-align:center; border-bottom:3px double var(--ink); padding-bottom:14px; }
.mast-title { font-family:Georgia,serif; font-size:26px; letter-spacing:.28em; font-weight:700; }
.mast-meta { margin-top:8px; font-family:var(--sans); font-size:11px; letter-spacing:.06em; color:var(--muted); display:flex; justify-content:center; gap:14px; flex-wrap:wrap; text-transform:uppercase; }

.stale { border:1px solid var(--action); background:var(--action-bg); color:var(--action); font-family:var(--sans); font-size:12.5px; padding:10px 14px; margin:14px 0 0; }

/* One strip for both controls: live-facts state on the left, filter on the right. */
.utility { display:flex; justify-content:space-between; align-items:center; gap:12px 24px; flex-wrap:wrap; padding:10px 0; border-bottom:1px solid var(--rule-light); }
.filterbar { display:flex; gap:6px; flex-wrap:wrap; }
.tag { display:inline-block; font-family:Helvetica,Arial,sans-serif; font-size:9.5px; font-weight:700; letter-spacing:.08em; padding:2px 7px; border:1px solid currentColor; }
.tag-bda { color:var(--bda); background:var(--bda-bg); }
.tag-hs { color:var(--hs); background:var(--hs-bg); }
.tag-personal { color:var(--pers); background:var(--pers-bg); }
.tag-other { color:var(--muted); background:var(--monitor-bg); }
.st-action { color:var(--action); background:var(--action-bg); }
.st-await { color:var(--await); background:var(--await-bg); }
.st-monitor { color:var(--monitor); background:var(--monitor-bg); }
.st-new { color:var(--new-c); background:var(--new-bg); }
.st-resolved { color:var(--muted); background:var(--monitor-bg); }
button.filter-btn { cursor:pointer; }
button.filter-btn.active { outline:2px solid var(--ink); outline-offset:1px; }

.doc-sec { margin-top:28px; }
.sec-label { font-family:Helvetica,Arial,sans-serif; font-size:12px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; border-bottom:1px solid var(--rule); padding-bottom:5px; margin-bottom:12px; }
.subsec-label { font-family:Helvetica,Arial,sans-serif; font-size:10.5px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); margin:16px 0 8px; }

/* ── overview: bottom line beside the week ── */
.overview { display:grid; grid-template-columns:minmax(0,1fr) 272px; gap:0 32px; margin-top:26px; }
@media (max-width:640px){ .overview { grid-template-columns:1fr; gap:24px 0; } }
.ov-bluf { min-width:0; }
.bluf { font-size:17.5px; line-height:1.5; font-weight:400; }
.keypoints { list-style:none; margin:14px 0 0; padding:0; border-top:1px solid var(--rule-light); }
.keypoints li { position:relative; padding:7px 0 7px 18px; border-bottom:1px solid var(--rule-light); font-size:14.5px; line-height:1.45; }
.keypoints li::before { content:''; position:absolute; left:2px; top:.95em; width:6px; height:6px; background:var(--ink); }

.ov-cal { min-width:0; font-family:var(--sans); }
.cal-head { display:flex; justify-content:space-between; align-items:baseline; gap:8px; flex-wrap:wrap; border-bottom:1px solid var(--rule); padding-bottom:5px; margin-bottom:6px; }
.cal-title { border:none; padding:0; margin:0; }
.cal-range { font-size:10.5px; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); font-variant-numeric:tabular-nums; }
.cal-spans { display:grid; gap:4px; padding:4px 0 6px; border-bottom:1px solid var(--rule-light); }
.cal-span { display:grid; grid-template-columns:repeat(7,1fr); grid-template-rows:5px auto; row-gap:4px; }
.cal-span-link { display:contents; color:inherit; text-decoration:none; }
.cal-span-bar { grid-row:1; grid-column:calc(var(--from) + 1) / calc(var(--to) + 1); border-top:5px solid var(--rule); }
.cal-span-text { grid-row:2; grid-column:1 / -1; font-size:12px; color:var(--ink); }
.cal-span-text strong { font-family:Georgia,serif; font-size:13px; font-weight:700; }
.cal-when { color:var(--muted); font-size:11px; }
.cal-days { display:grid; }
.cal-day { display:grid; grid-template-columns:46px minmax(0,1fr); gap:0 10px; padding:7px 0 7px 4px; margin:0 -4px; border-bottom:1px solid var(--rule-light); align-items:start; }
.cal-day:last-child { border-bottom:none; }
.cal-day.is-focus { background:var(--focus-bg); border-bottom-color:var(--focus-rule); box-shadow:0 -1px 0 var(--focus-rule); }
.cal-day.is-past .cal-events, .cal-day.is-past .cal-num, .cal-day.is-past .cal-wd { opacity:.45; }
.cal-date { display:flex; flex-direction:column; line-height:1; padding-top:2px; }
.cal-wd { font-size:9.5px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }
.cal-num { font-family:Georgia,serif; font-size:19px; font-weight:700; margin-top:3px; font-variant-numeric:tabular-nums; }
.cal-cap { font-size:8.5px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--action); margin-top:4px; }
.cal-day.is-past .cal-cap { color:var(--muted); }
.cal-events { display:grid; gap:5px; min-width:0; }
.cal-empty { color:var(--rule); font-family:Georgia,serif; font-size:14px; line-height:1.6; }
.cal-ev { display:grid; grid-template-columns:auto minmax(0,1fr); gap:0 8px; align-items:baseline; border-left:3px solid var(--rule); padding:1px 0 1px 8px; color:inherit; text-decoration:none; }
a.cal-ev:hover .cal-name { text-decoration:underline; }
.cal-time { font-size:10.5px; font-weight:700; color:var(--muted); font-variant-numeric:tabular-nums; white-space:nowrap; letter-spacing:.02em; }
.cal-end { font-weight:400; }
.cal-body { min-width:0; }
.cal-name { display:block; font-family:Georgia,serif; font-size:13.5px; line-height:1.3; color:var(--ink); overflow-wrap:anywhere; }
.cal-loc { display:block; font-size:10.5px; color:var(--muted); margin-top:1px; overflow-wrap:anywhere; }

.items { list-style:none; counter-reset:item; }
.item { counter-increment:item; padding:16px 0 18px; border-bottom:1px solid var(--rule-light); }
.item:last-child { border-bottom:none; }
.item-head { display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; }
.item-title { font-size:17px; font-weight:700; }
.item-title::before { content:counter(item) '.  '; }
.item-tags { display:flex; gap:6px; flex:none; }
.item-body { margin-top:8px; }
.field { margin-bottom:6px; font-size:14.5px; }
.field-label { font-family:Helvetica,Arial,sans-serif; font-size:10.5px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
.action-line { margin-top:10px; border-left:3px solid var(--action); background:var(--action-bg); padding:8px 12px; }
.action-label { display:block; font-family:Helvetica,Arial,sans-serif; font-size:10px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--action); margin-bottom:2px; }
.action-text { font-size:14.5px; }
.item-links { margin-top:10px; display:flex; gap:18px; flex-wrap:wrap; }
.doc-link { font-family:Helvetica,Arial,sans-serif; font-size:12px; font-weight:700; letter-spacing:.03em; color:var(--await); text-decoration:none; border-bottom:1px solid var(--await); }
.doc-link:hover { opacity:.75; }

.none { color:var(--muted); font-style:italic; }

.proposal { padding:9px 0; border-bottom:1px dotted var(--rule-light); font-size:14.5px; }
.proposal-line { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
.proposal-controls { display:flex; gap:14px; margin-top:7px; align-items:center; flex-wrap:wrap; }
.proposal-controls input { font-family:Helvetica,Arial,sans-serif; font-size:12.5px; padding:4px 7px; border:1px solid var(--rule); background:var(--paper); color:var(--ink); }

.sec-note { font-size:12.5px; color:var(--muted); font-style:italic; margin:-6px 0 10px; }
.link-btn { background:none; border:none; padding:0; font:inherit; font-style:normal; color:var(--await); text-decoration:underline; cursor:pointer; }

.tasks { list-style:none; }
.tasks li.task { display:flex; align-items:flex-start; gap:11px; padding:9px 0; border-bottom:1px dotted var(--rule-light); }
.tasks.hide-done li.task.done:not(.auto) { display:none; }
.tasks-subhead { font-family:Helvetica,Arial,sans-serif; font-size:10px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); padding:14px 0 4px; border-bottom:1px dotted var(--rule-light); list-style:none; }
.task.auto .t-check { cursor:default; }
.t-check { width:17px; height:17px; margin-top:2px; flex:none; accent-color:var(--hs, #2F5D3A); cursor:pointer; }
.t-label { flex:1; cursor:pointer; display:block; }
.t-pri { font-family:Helvetica,Arial,sans-serif; font-size:9.5px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; margin-right:7px; }
.t-hi { color:var(--action); }
.t-md { color:#6E5518; }
.t-lo { color:var(--muted); }
.t-text { font-size:14.5px; }
.refresh-bar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.rb-state { font-family:var(--sans); font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
.rb-state.rb-fresh { color:var(--hs); }
.rb-state.rb-error { color:var(--action); }
.rb-btn { font-family:var(--sans); font-size:10.5px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; padding:4px 10px; border:1px solid var(--ink); background:transparent; color:var(--ink); cursor:pointer; }
.rb-btn:hover { background:var(--ink); color:var(--paper); }
.rb-btn[disabled] { opacity:.5; cursor:default; }
.q-answered .q-subject, .q-answered .q-sender { text-decoration:line-through; opacity:.6; }
.q-answered-tag { font-family:var(--sans); font-size:10px; letter-spacing:.05em; text-transform:uppercase; color:var(--hs); margin-left:8px; }
.new-since { margin-top:16px; }
.new-since li { padding:6px 0; border-bottom:1px solid var(--rule-light); font-size:13.5px; }
.new-since .ns-sender { font-weight:600; }
.new-since .ns-subject { color:var(--muted); }
.queue-subhead { font-family:Helvetica,Arial,sans-serif; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin:18px 0 6px; font-weight:600; }
.queue-muted > li { opacity:.72; }
.t-sub { display:block; font-family:Helvetica,Arial,sans-serif; font-size:10.5px; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); margin-top:3px; }
/* What was actually said. Italic and quoted so it reads as their words, not a
   label; it is often the only context left once the text ages out. */
.t-ctx { display:block; font-size:12.5px; font-style:italic; color:var(--muted); margin-top:3px; line-height:1.4; }
.t-ctx::before { content:'“'; }
.t-ctx::after { content:'”'; }
.task.done .t-text { text-decoration:line-through; }
.task.done { opacity:.5; }
.queue { list-style:none; }
.queue li { display:flex; justify-content:space-between; align-items:baseline; gap:16px; padding:8px 0; border-bottom:1px dotted var(--rule-light); flex-wrap:wrap; }
.q-main { display:flex; align-items:baseline; gap:8px; flex:1; min-width:260px; flex-wrap:wrap; }
.q-sender { font-weight:700; font-size:14px; }
.q-subject { font-size:14px; color:var(--muted); }
.q-meta { display:flex; align-items:baseline; gap:12px; flex:none; }
.q-ref { font-family:Helvetica,Arial,sans-serif; font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--action); }
.q-age { font-family:Helvetica,Arial,sans-serif; font-size:11px; color:var(--muted); font-variant-numeric:tabular-nums; }

.devs { list-style:none; }
.devs li { padding:7px 0; border-bottom:1px dotted var(--rule-light); font-size:14.5px; }
.routine { font-size:14.5px; color:var(--muted); }

.appendix summary { cursor:pointer; font-family:Helvetica,Arial,sans-serif; font-size:12px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); padding:6px 0; }
.raw-list { list-style:none; }
.raw-list li { padding:6px 0; border-bottom:1px dotted var(--rule-light); font-size:13.5px; }

.doc footer { padding:22px 0 0; margin-top:30px; border-top:3px double var(--ink); font-family:var(--sans); font-size:11px; color:var(--muted); display:grid; gap:4px; }
[data-account].hidden-by-filter { display:none; }

@media print {
  body { background:#fff; }
  .doc { max-width:none; border:none; padding:0; }
  .utility, .doc-link, .t-check { display:none; }
  .overview { grid-template-columns:1fr 240px; }
  .item, .cal-day, .tasks li, .queue li { break-inside:avoid; }
  .appendix { display:none; }
}
`;
}

// ── client JS ────────────────────────────────────────────────────────────────
/**
 * The live-facts control.
 *
 * The analysis below is written once a day and stays true; the facts under it
 * rot as soon as Ben answers something. A background job republishes just those
 * facts every few minutes, and this pulls the newest set on demand, so a brief
 * read at 9pm can be told which of its asks he has already dealt with.
 *
 * Reports its own ignorance honestly: if the job has died, the line says how
 * old the facts are rather than implying they are current.
 */
function clientJs() {
  return `
function filterAccount(btn) {
  var target = btn.getAttribute('data-account');
  document.querySelectorAll('.filter-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
  document.querySelectorAll('[data-account]').forEach(function (el) {
    if (el.classList.contains('filter-btn')) return;
    var a = el.getAttribute('data-account') || '';
    el.classList.toggle('hidden-by-filter', target !== 'all' && a !== '' && a !== target);
  });
}
function updateCalLink(id) {
  var input = document.getElementById(id + '-start');
  var link = document.getElementById(id + '-link');
  if (!input || !link || !input.value) return;
  var start = new Date(input.value);
  if (isNaN(start)) return;
  var end = new Date(start.getTime() + 30 * 60000);
  function stamp(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\\.\\d{3}Z$/, 'Z'); }
  var p = new URLSearchParams({ action: 'TEMPLATE', text: link.getAttribute('data-title') || 'New event' });
  var au = new URL(link.href).searchParams.get('authuser');
  if (au) p.set('authuser', au);
  p.set('dates', stamp(start) + '/' + stamp(end));
  var details = link.getAttribute('data-details'); if (details) p.set('details', details);
  var loc = link.getAttribute('data-location'); if (loc) p.set('location', loc);
  link.href = 'https://calendar.google.com/calendar/render?' + p.toString();
}
function addToSchedule(id) {
  return true; // navigation proceeds via the <a target="_blank">
}

// ── live facts ───────────────────────────────────────────────────────────────
// Pulls the newest published fact set and reconciles this document against it.
// The analysis stays as written; only thread standing, action items and the
// count of new arrivals move. Everything is decided here rather than in the
// job, because this side is the only one that knows what it is displaying.
var STATUS_URL = 'status.enc';
var BRIEF_GENERATED_AT = ${JSON.stringify(String(meta.generatedAt || ''))};

function rbSay(text, cls) {
  var el = document.getElementById('rb-state');
  if (!el) return;
  el.textContent = text;
  el.className = 'rb-state' + (cls ? ' ' + cls : '');
}

function b64ToBytesLocal(b64) {
  var bin = atob(b64);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** BAS1 container: "BAS1" | salt(16) | iv(12) | ciphertext | tag(16). */
async function decryptBas1(bytes, password) {
  if (bytes.length < 48 || String.fromCharCode.apply(null, bytes.slice(0, 4)) !== 'BAS1') {
    throw new Error('not a BAS1 blob');
  }
  var salt = bytes.slice(4, 20);
  var iv = bytes.slice(20, 32);
  var body = bytes.slice(32);
  var material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  var key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt, iterations: 250000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  );
  var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, body);
  return JSON.parse(new TextDecoder().decode(plain));
}

function normSubject(s) {
  return String(s || '').toLowerCase().replace(/^((re|fwd?|fw)\s*:\s*)+/i, '').trim();
}

async function refreshFacts() {
  var btn = document.getElementById('rb-btn');
  var pw = null;
  try { pw = sessionStorage.getItem('briefing.key'); } catch (e) {}
  if (!pw) { rbSay('Reload the page and unlock it to check for updates', 'rb-error'); return; }

  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  rbSay('Checking…');
  try {
    // Cache-busted: GitHub Pages will happily serve a stale copy otherwise,
    // which is the one failure that would silently defeat the whole feature.
    var res = await fetch(STATUS_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('status ' + res.status);
    var buf = new Uint8Array(await res.arrayBuffer());
    var facts = await decryptBas1(buf, pw);
    // Right after the daily run the published facts can predate the briefing
    // itself. Applying them would walk the document backwards, so say so
    // instead. The refresh job will overtake within a few minutes.
    var factsAt = Date.parse(facts.generatedAt) || 0;
    var briefAt = Date.parse(BRIEF_GENERATED_AT) || 0;
    if (briefAt && factsAt && factsAt < briefAt) {
      rbSay('The briefing is newer than the last fact check — nothing to add');
      return;
    }
    applyFacts(facts);
  } catch (e) {
    rbSay('Could not reach the live facts — showing the briefing as written', 'rb-error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check for updates'; }
  }
}

function applyFacts(facts) {
  var byKey = {}, answeredSubjects = {};
  var threads = facts.threads || [];
  for (var i = 0; i < threads.length; i++) {
    var t = threads[i];
    byKey[t.key] = t;
    // Pool by subject as the pipeline does, so a reply sent from a Workspace
    // address also settles the personal copy of the same thread — which this
    // job cannot see directly.
    if (t.latestFromMe || t.status === 'waiting_on_other' || t.status === 'thread_continued') {
      var sk = normSubject(t.subject);
      if (sk.length >= 8) answeredSubjects[sk] = true;
    }
  }

  var settled = 0;
  var rows = document.querySelectorAll('.queue li[data-convkey]');
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    if (row.getAttribute('data-status') !== 'waiting_on_ben') continue;
    var t2 = byKey[row.getAttribute('data-convkey')];
    var subjHit = answeredSubjects[row.getAttribute('data-subjkey') || '\u0000'];
    var nowAnswered = (t2 && (t2.latestFromMe || t2.status !== 'waiting_on_ben')) || subjHit;
    if (!nowAnswered) continue;
    row.classList.add('q-answered');
    row.setAttribute('data-status', 'answered');
    if (!row.querySelector('.q-answered-tag')) {
      var tag = document.createElement('span');
      tag.className = 'q-answered-tag';
      tag.textContent = 'answered since';
      var main = row.querySelector('.q-main');
      if (main) main.appendChild(tag);
    }
    settled++;
  }

  // A reply on the thread also completes the action item that asked for it.
  var ticked = 0;
  var tasks = document.querySelectorAll('.task[data-convkey]');
  for (var k = 0; k < tasks.length; k++) {
    var task = tasks[k];
    if (task.classList.contains('done')) continue;
    var key = task.getAttribute('data-convkey');
    if (!key) continue;
    var t3 = byKey[key];
    if (!t3 || !t3.latestFromMe) continue;
    var box = task.querySelector('.t-check');
    if (box && !box.checked) { box.checked = true; toggleTask(box); }
    ticked++;
  }

  var arrived = countNewSince(threads);
  var when = new Date(facts.generatedAt);
  var stamp = isNaN(when) ? 'just now' : when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  var parts = ['Facts as of ' + stamp];
  if (settled) parts.push(settled + ' answered since');
  if (ticked) parts.push(ticked + ' item' + (ticked === 1 ? '' : 's') + ' cleared');
  if (arrived) parts.push(arrived + ' new');
  if (!settled && !ticked && !arrived) parts.push('nothing has changed');
  rbSay(parts.join(' · '), 'rb-fresh');
}

/**
 * Threads whose newest message postdates this briefing and which it never
 * mentioned. Listed as bare facts: the job is deterministic code and cannot
 * judge whether any of them matter, so they are kept apart from the analysis
 * rather than mixed into it.
 */
function countNewSince(threads) {
  var known = {};
  var seen = document.querySelectorAll('[data-convkey]');
  for (var i = 0; i < seen.length; i++) known[seen[i].getAttribute('data-convkey')] = true;

  var cutoff = Date.parse(BRIEF_GENERATED_AT) || 0;
  var fresh = [];
  for (var j = 0; j < threads.length; j++) {
    var t = threads[j];
    if (known[t.key]) continue;
    if (t.latestFromMe) continue;
    if (t.status === 'fyi' || t.status === 'unknown') continue;
    var at = Date.parse(t.latestDate) || 0;
    if (!cutoff || at <= cutoff) continue;
    fresh.push(t);
  }
  fresh.sort(function (a, b) { return Date.parse(b.latestDate) - Date.parse(a.latestDate); });
  renderNewSince(fresh);
  return fresh.length;
}

function renderNewSince(list) {
  var host = document.getElementById('new-since');
  if (!host) {
    var queue = document.querySelector('.doc-sec .queue');
    if (!queue) return;
    host = document.createElement('div');
    host.id = 'new-since';
    host.className = 'new-since';
    queue.parentNode.appendChild(host);
  }
  if (!list.length) { host.innerHTML = ''; return; }
  var html = '<h3 class="queue-subhead">Arrived since this briefing (' + list.length + ')</h3><ul>';
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    var sender = String(t.sender || '').replace(/[<>&]/g, '');
    var subject = String(t.subject || '(no subject)').replace(/[<>&]/g, '');
    html += '<li><span class="ns-sender">' + sender + '</span> — <span class="ns-subject">' + subject + '</span></li>';
  }
  host.innerHTML = html + '</ul><p class="sec-note">Not weighed by the analysis above, which was written earlier.</p>';
}

// ── action item completion ──────────────────────────────────────────────────
// Completion is stored in the browser, keyed by the task's stable id, so a
// checked item stays checked across reloads and across daily republishes of
// this page. The pipeline carries uncompleted items forward until they are done.
var TASK_STORE = 'briefing.tasks.done.v1';
function loadDoneTasks() {
  try { return JSON.parse(localStorage.getItem(TASK_STORE)) || {}; } catch (e) { return {}; }
}
function saveDoneTasks(map) {
  try { localStorage.setItem(TASK_STORE, JSON.stringify(map)); } catch (e) {}
}
function toggleTask(input) {
  var id = input.getAttribute('data-task-id');
  var row = input.closest('.task');
  var done = loadDoneTasks();
  if (input.checked) { done[id] = new Date().toISOString(); }
  else { delete done[id]; }
  saveDoneTasks(done);
  if (row) row.classList.toggle('done', input.checked);
  refreshTaskCount();
}
function toggleCompleted() {
  var list = document.getElementById('task-list');
  var btn = document.getElementById('task-toggle');
  if (!list || !btn) return;
  var hiding = list.classList.toggle('hide-done');
  btn.textContent = hiding ? 'Show completed' : 'Hide completed';
}
function refreshTaskCount() {
  var el = document.getElementById('task-open-count');
  if (!el) return;
  var open = document.querySelectorAll('.task:not(.done)').length;
  el.textContent = open;
}
function restoreTasks() {
  var done = loadDoneTasks();
  document.querySelectorAll('.task').forEach(function (row) {
    if (row.classList.contains('auto')) return; // completed server-side; not toggleable
    var id = row.getAttribute('data-task-id');
    if (!done[id]) return;
    row.classList.add('done');
    var box = row.querySelector('.t-check');
    if (box) box.checked = true;
  });
  refreshTaskCount();
}
// The encrypted shell injects this document via document.write(), so
// DOMContentLoaded may already have fired by the time this runs. Restore
// immediately when the document is ready, otherwise wait for the event.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', restoreTasks);
} else {
  restoreTasks();
}
`;
}
