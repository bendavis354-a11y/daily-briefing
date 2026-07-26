/**
 * Render the daily briefing as a formal briefing document.
 *
 * Format follows established briefing conventions — President's Daily Brief
 * (short numbered items, each present because it merits attention or ties to an
 * upcoming decision) and BLUF memo structure (bottom line first, compressed
 * background, supporting detail relegated to an appendix):
 *
 *   1. BOTTOM LINE   — 1–3 sentence BLUF plus key points
 *   2. PRIORITY ITEMS — numbered; Background / Development / Assessment /
 *                       Action; status + account designators; thread link
 *   3. ACTION ITEMS  — persistent checklist; items carry forward across days
 *                       and are checked off in the page (localStorage)
 *   4. CORRESPONDENCE REQUIRING RESPONSE — exhaustive list of threads awaiting
 *                       a reply, oldest first; derived from the scan (not from
 *                       the analysis step) so nothing can be dropped by
 *                       editorial judgment; newsletters and spam excluded
 *   5. SCHEDULE      — tomorrow's commitments, proposed calendar entries
 *   6. OTHER DEVELOPMENTS — one-line items
 *   7. ROUTINE TRAFFIC — one-line disposition of the compressed mass
 *   Appendix         — full categorized traffic, collapsed
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

function filterBar() {
  const btns = (briefing.accounts || []).map(a => {
    const { label, cls } = acct(a.email);
    return `<button class="tag ${cls} filter-btn" data-account="${escAttr((a.email || '').toLowerCase())}" onclick="filterAccount(this)">${esc(label)}</button>`;
  }).join('');
  return `<nav class="filterbar" role="group" aria-label="Filter by account">
    <button class="tag tag-other filter-btn active" data-account="all" onclick="filterAccount(this)">ALL</button>${btns}
  </nav>`;
}

function bottomLine() {
  const b = brief || fallbackBrief();
  return `
  <section class="doc-sec">
    <h2 class="sec-label">1. Bottom line</h2>
    <p class="bluf">${esc(b.bottomLine)}</p>
    ${b.keyPoints?.length ? `<ul class="keypoints">${b.keyPoints.map(k => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
  </section>`;
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
    <h2 class="sec-label">2. Priority items</h2>
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
    <h2 class="sec-label">3. Action items — <span id="task-open-count">${open.length}</span> open</h2>
    <p class="sec-note">Items remain until checked off. Items answered by an email reply are checked automatically. <button type="button" class="link-btn" id="task-toggle" onclick="toggleCompleted()">Show completed</button></p>
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
  return `<li class="task" data-account="${escAttr((t.account || '').toLowerCase())}" data-task-id="${escAttr(id)}">
    <input type="checkbox" class="t-check" id="${domId}" data-task-id="${escAttr(id)}" onchange="toggleTask(this)">
    <label class="t-label" for="${domId}">
      <span class="t-pri ${priCls}">${esc(pri)}</span>
      <span class="t-text">${esc(t.text || '')}</span>
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
  const rows = [];
  for (const list of pools) {
    for (const it of list || []) {
      if (it.status !== 'waiting_on_ben') continue;
      const key = it.conversationKey || `${it.sender || ''}|${it.subject || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...it, _key: key, _ts: Date.parse(it.date || '') || null });
    }
  }
  if (!rows.length) {
    return `
  <section class="doc-sec">
    <h2 class="sec-label">4. Correspondence requiring response</h2>
    <p class="none">No threads are currently awaiting a reply.</p>
  </section>`;
  }

  rows.sort((a, b) => {
    if (a._ts && b._ts) return a._ts - b._ts;
    if (a._ts) return -1;
    if (b._ts) return 1;
    return 0;
  });

  return `
  <section class="doc-sec">
    <h2 class="sec-label">4. Correspondence requiring response — ${rows.length} thread${rows.length === 1 ? '' : 's'}</h2>
    <p class="sec-note">Complete list of threads awaiting a reply, oldest first. Newsletters and unsolicited mail excluded.</p>
    <ul class="queue">${rows.map(queueRow).join('')}</ul>
  </section>`;
}

function queueRow(r) {
  const href = threadLink(r.viewThreadAccount || r.account, r.viewThreadId || r.gmailThreadId);
  const num = itemNumberByKey.get(r._key);
  const age = waitingLabel(r._ts);
  return `<li data-account="${escAttr((r.account || '').toLowerCase())}">
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

function schedule() {
  const tomorrow = sections.tomorrowSchedule || [];
  const week = sections.weekSchedule || [];
  const proposals = sections.calendarProposals || [];
  if (!tomorrow.length && !week.length && !proposals.length) return '';
  return `
  <section class="doc-sec">
    <h2 class="sec-label">5. Schedule — ${esc(meta.tomorrowLabel || 'tomorrow')}</h2>
    <div id="tomorrow-schedule" class="sched">
      ${tomorrow.length ? tomorrow.map(eventRow).join('') : '<p class="none">No commitments scheduled.</p>'}
    </div>
    ${proposals.length ? `
    <h3 class="subsec-label">Proposed calendar entries</h3>
    ${proposals.map(proposalRow).join('')}` : ''}
    ${week.length > tomorrow.length ? `
    <details class="week"><summary>Remainder of week — ${week.length} events</summary>
      <div class="sched">${week.map(eventRow).join('')}</div>
    </details>` : ''}
  </section>`;
}

function eventRow(ev) {
  const t = ev.allDay ? 'ALL DAY' : fmtTime(ev.start);
  return `<div class="sched-row">
    <span class="sched-time">${esc(t)}</span>
    <span class="sched-body"><strong>${esc(ev.title)}</strong>${ev.location ? `, ${esc(ev.location)}` : ''} <span class="sched-cal">(${esc(ev.calendarName || '')})</span></span>
    ${ev.htmlLink ? extA(ev.htmlLink, 'doc-link', 'Open →') : ''}
  </div>`;
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
    <h2 class="sec-label">6. Other developments</h2>
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
    <h2 class="sec-label">7. Routine traffic</h2>
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
    <div>Basis: ${s.emailsScanned ?? 0} messages, ${(briefing.accounts || []).length} accounts · ${tracked} items under continuing coverage · generated ${esc(fmtTime(meta.generatedAt))} ET</div>
    <div>No automated actions are taken on this account. All links open the source thread or calendar for review.</div>
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
    ${filterBar()}
    ${bottomLine()}
    ${priorityItems()}
    ${actionItems()}
    ${responseQueue()}
    ${schedule()}
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
}
* { box-sizing:border-box; margin:0; padding:0; }
body { background:#F2F1EC; color:var(--ink); font-family:Georgia,'Times New Roman',serif; font-size:15.5px; line-height:1.55; }
.doc { max-width:720px; margin:0 auto; background:var(--paper); min-height:100vh; padding:36px 44px 48px; border-left:1px solid var(--rule-light); border-right:1px solid var(--rule-light); }
@media (max-width:600px){ .doc { padding:24px 18px 40px; } }
a { color:var(--await); }

.masthead { text-align:center; border-bottom:3px double var(--ink); padding-bottom:14px; margin-bottom:8px; }
.mast-title { font-family:Georgia,serif; font-size:26px; letter-spacing:.28em; font-weight:700; }
.mast-meta { margin-top:8px; font-family:Helvetica,Arial,sans-serif; font-size:11px; letter-spacing:.06em; color:var(--muted); display:flex; justify-content:center; gap:14px; flex-wrap:wrap; text-transform:uppercase; }

.stale { border:1px solid var(--action); background:var(--action-bg); color:var(--action); font-family:Helvetica,Arial,sans-serif; font-size:12.5px; padding:10px 14px; margin:14px 0 0; }

.filterbar { display:flex; gap:6px; justify-content:center; padding:12px 0 4px; border-bottom:1px solid var(--rule-light); }
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

.bluf { font-size:17px; line-height:1.5; font-weight:400; }
.keypoints { margin:10px 0 0 20px; }
.keypoints li { margin-bottom:5px; font-size:15px; }

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

.sched { display:grid; gap:2px; }
.sched-row { display:flex; gap:14px; align-items:baseline; padding:7px 0; border-bottom:1px dotted var(--rule-light); font-size:14.5px; }
.sched-time { font-family:Helvetica,Arial,sans-serif; font-size:11.5px; font-weight:700; min-width:70px; color:var(--muted); font-variant-numeric:tabular-nums; }
.sched-body { flex:1; }
.sched-cal { color:var(--muted); font-size:13px; }
.none { color:var(--muted); font-style:italic; }
.week summary { cursor:pointer; font-family:Helvetica,Arial,sans-serif; font-size:12px; color:var(--muted); margin-top:10px; }

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
.t-sub { display:block; font-family:Helvetica,Arial,sans-serif; font-size:10.5px; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); margin-top:3px; }
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

footer { max-width:720px; margin:0 auto; padding:16px 44px 40px; font-family:Helvetica,Arial,sans-serif; font-size:11px; color:var(--muted); display:grid; gap:4px; border-top:none; }
.doc footer { padding:22px 0 0; margin-top:30px; border-top:3px double var(--ink); }
[data-account].hidden-by-filter { display:none; }
`;
}

// ── client JS ────────────────────────────────────────────────────────────────
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
  p.set('dates', stamp(start) + '/' + stamp(end));
  var details = link.getAttribute('data-details'); if (details) p.set('details', details);
  var loc = link.getAttribute('data-location'); if (loc) p.set('location', loc);
  link.href = 'https://calendar.google.com/calendar/render?' + p.toString();
}
function addToSchedule(id) {
  return true; // navigation proceeds via the <a target="_blank">
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
