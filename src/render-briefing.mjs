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

const sections = briefing.sections || {};
const calendars = briefing.calendars?.length ? briefing.calendars : defaultCalendars();
const todayISO = localISODate(new Date(), briefing.metadata.timezone);
const isStale = briefing.metadata.date !== todayISO;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Inbox Briefing</title>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>${css()}</style>
</head>
<body>
  <header class="topbar">
    <div>
      <div class="kicker">Ben Assistant</div>
      <div class="top-title">Inbox Briefing</div>
    </div>
    <div class="top-meta">
      <span>${esc(briefing.metadata.date)}</span>
      <span>${actionCount()} actions</span>
    </div>
  </header>

  <main>
    ${isStale ? staleWarning() : ''}
    <section class="hero">
      <div>
        <h1>Good evening, Ben</h1>
        <p>${esc(summaryLine())}</p>
      </div>
      <div class="build-meta">
        <div>Generated</div>
        <strong>${esc(formatDateTime(briefing.metadata.generatedAt))}</strong>
        <div>Fresh through</div>
        <strong>${esc(formatDateTime(briefing.metadata.dataFreshThrough))}</strong>
      </div>
    </section>

    ${statsRow()}
    ${accountFilters()}
    ${emailCards('Urgent', 'urgent', sections.urgent, 'urgent')}
    ${scheduleSection(sections.tomorrowSchedule)}
    ${calendarProposalSection(sections.calendarProposals)}
    ${replySection(sections.suggestedReplies)}
    ${todoSection(sections.todos)}
    ${categorySection('Business', sections.business)}
    ${categorySection('Personal', sections.personal)}
    ${categorySection('Financial', sections.financial)}
    ${categorySection('Waiting / FYI', sections.waiting)}
    ${summaryBlock('Newsletter / Info', sections.newsletter)}
    ${summaryBlock('Spam / Junk', sections.spam)}
    ${accountTotals()}
  </main>

  <footer>No emails sent automatically. Replies open Gmail compose; Ben writes and sends.</footer>
  <script>${clientJs()}</script>
</body>
</html>`;

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync(outPath, html);
console.log(`Rendered ${outPath}`);

function actionCount() {
  return num(briefing.stats.urgent) + num(briefing.stats.proposedEvents) + num(briefing.stats.suggestedReplies) + num(briefing.stats.todos);
}

function summaryLine() {
  const stats = briefing.stats || {};
  const urgent = num(stats.urgent);
  const replies = num(stats.suggestedReplies);
  const todos = num(stats.todos);
  const events = num(stats.eventsTomorrow);
  if (urgent) return `${urgent} urgent item${urgent === 1 ? '' : 's'}, ${events} event${events === 1 ? '' : 's'} tomorrow, and ${todos + replies} suggested action${todos + replies === 1 ? '' : 's'}.`;
  return `${events} event${events === 1 ? '' : 's'} tomorrow and ${todos + replies} suggested action${todos + replies === 1 ? '' : 's'}.`;
}

function staleWarning() {
  return `<div class="stale">This briefing may be stale. Expected ${esc(todayISO)}, but the page was built for ${esc(briefing.metadata.date)}. Last successful build: ${esc(formatDateTime(briefing.metadata.lastSuccessfulBuildAt))}.</div>`;
}

function statsRow() {
  const s = briefing.stats || {};
  return `<section class="stats">
    ${stat('Urgent', s.urgent, 'red')}
    ${stat('Events Tomorrow', s.eventsTomorrow, 'green')}
    ${stat('Replies', s.suggestedReplies, 'blue')}
    ${stat('To-dos', s.todos, 'gold')}
  </section>`;
}

function stat(label, value, tone) {
  return `<div class="stat ${tone}"><div>${num(value)}</div><span>${esc(label)}</span></div>`;
}

function accountFilters() {
  const accounts = briefing.accounts || [];
  if (!accounts.length) return '';
  return `<nav class="filters" aria-label="Account filters">
    <button class="filter active" data-filter="all" onclick="filterAccount('all', this)">All</button>
    ${accounts.map(a => `<button class="filter" data-filter="${attr(a.email)}" onclick="filterAccount('${jsStr(a.email)}', this)">${esc(a.label || a.email)}</button>`).join('')}
  </nav>`;
}

function emailCards(title, marker, items = [], className = '') {
  if (!items?.length) return '';
  return `<section class="section">
    ${sectionHeader(title, marker)}
    <div class="card-grid">
      ${items.map(item => `<article class="email-card ${attr(className)}" data-account="${attr(accountOf(item))}">
        ${accountChip(item)}
        <div class="email-from">${esc(item.senderName || item.sender || item.from || 'Unknown sender')}</div>
        <div class="email-subject">${esc(item.subject || item.title || '(no subject)')}</div>
        <div class="email-summary">${esc(item.summary || item.snippet || item.detail || '')}</div>
        <div class="email-meta">
          ${item.deadline ? `<span class="email-tag deadline">${esc(item.deadline)}</span>` : ''}
          ${gmailThreadLink(item, 'View in Gmail &rarr;', 'email-tag link-tag')}
        </div>
      </article>`).join('')}
    </div>
  </section>`;
}

function scheduleSection(events = []) {
  const sorted = [...(events || [])].sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
  const grouped = sorted.length >= 4;
  return `<section class="section" id="tomorrow-section">
    ${sectionHeader("Tomorrow's Schedule", 'calendar')}
    <div id="tomorrow-schedule">
      ${sorted.length ? (grouped ? groupedSchedule(sorted) : sorted.map(scheduleEvent).join('')) : '<div class="no-events">No events scheduled for tomorrow</div>'}
    </div>
  </section>`;
}

function groupedSchedule(events) {
  const groups = { Morning: [], Afternoon: [], Evening: [] };
  for (const ev of events) {
    const hour = hourOf(ev.start);
    if (hour < 12) groups.Morning.push(ev);
    else if (hour < 17) groups.Afternoon.push(ev);
    else groups.Evening.push(ev);
  }
  return Object.entries(groups).filter(([, list]) => list.length).map(([label, list]) =>
    `<div class="schedule-group"><div class="schedule-group-title">${esc(label)}</div>${list.map(scheduleEvent).join('')}</div>`
  ).join('');
}

function scheduleEvent(ev) {
  const color = ev.color || calendarColor(ev.calendarName || ev.calendarId);
  const link = ev.htmlLink || calendarEventLink(ev);
  return `<div class="schedule-event">
    <div class="schedule-time">${esc(timeRange(ev.start, ev.end, ev.allDay))}</div>
    <div class="schedule-info">
      <div class="schedule-title">${esc(ev.title || ev.summary || '(no title)')}</div>
      <div class="schedule-calendar" style="color:${attr(color)}">● ${esc(ev.calendarName || 'Calendar')}</div>
      ${ev.location ? `<div class="schedule-location">${esc(ev.location)}</div>` : ''}
    </div>
    ${link ? `<a href="${attr(link)}" target="_blank" rel="noopener noreferrer" class="schedule-link">Open &rarr;</a>` : ''}
  </div>`;
}

function calendarProposalSection(items = []) {
  if (!items?.length) return '';
  return `<section class="section">
    ${sectionHeader('Calendar Event Proposals', 'calendar')}
    <div class="action-list">${items.map((item, idx) => calendarProposal(item, idx)).join('')}</div>
  </section>`;
}

function calendarProposal(item, idx) {
  const id = item.id || `event-${idx + 1}`;
  const selectedCal = item.calendarId || calendars[0]?.id || 'primary';
  return `<div class="action-card calendar" data-account="${attr(accountOf(item))}" id="${attr(id)}"
    data-event-title="${attr(item.title || 'New event')}"
    data-event-start="${attr(item.start || '')}"
    data-event-end="${attr(item.end || item.start || '')}"
    data-event-calendar="${attr(calendarName(selectedCal))}"
    data-event-location="${attr(item.location || '')}">
    ${accountChip(item)}
    <div class="action-type cal">Calendar Event</div>
    <div class="action-title">${esc(item.title || 'New event')}</div>
    <div class="action-detail">${esc(item.detail || dateRange(item.start, item.end))}</div>
    ${item.context ? `<div class="action-detail">${esc(item.context)}</div>` : ''}
    ${sourceLine(item)}
    <div class="action-buttons">
      <select class="calendar-select" onchange="updateCalLink('${jsStr(id)}', this.value, this)" data-calendars>
        ${calendars.map(cal => `<option value="${attr(cal.id)}" data-cal-name="${attr(cal.name)}"${cal.id === selectedCal ? ' selected' : ''}>${esc(cal.name)}</option>`).join('')}
      </select>
      <a href="${attr(calendarCreateLink(item, selectedCal))}" target="_blank" rel="noopener noreferrer" class="action-btn primary" id="cal-link-${attr(id)}" onclick="addToSchedule(this)">Add to Calendar</a>
      <button class="action-btn" onclick="this.closest('.action-card').style.display='none'">Skip</button>
    </div>
  </div>`;
}

function replySection(items = []) {
  if (!items?.length) return '';
  return `<section class="section">
    ${sectionHeader('Suggested Replies', 'reply')}
    <div class="action-list">${items.map(item => `<div class="action-card reply" data-account="${attr(accountOf(item))}">
      ${accountChip(item)}
      <div class="action-type rep">Suggested Reply</div>
      <div class="action-title">${esc(item.title || item.subject || 'Suggested reply')}</div>
      <div class="action-detail">${esc(item.detail || item.reason || '')}</div>
      ${sourceLine(item)}
      <div class="reply-preview">${esc(item.body || item.replyBody || '')}</div>
      <div class="action-buttons">
        <a href="${attr(replyLink(item))}" target="_blank" rel="noopener noreferrer" class="action-btn primary">Reply in Gmail</a>
        ${gmailThreadLink(item, 'View Thread', 'action-btn')}
        <button class="action-btn" onclick="this.closest('.action-card').style.display='none'">Skip</button>
      </div>
    </div>`).join('')}</div>
  </section>`;
}

function makeTodoId(item) {
  const raw = [item.id || '', item.conversationKey || '', item.text || item.title || item.summary || '', accountOf(item)].join('\x00');
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0;
  return 'todo_' + (h >>> 0).toString(36);
}

function todoSection(items = []) {
  if (!items?.length) return '';
  return `<section class="section">
    ${sectionHeader('To-do List', 'todo')}
    <div class="todo-list">${items.map(item => {
      const tid = makeTodoId(item);
      return `<div class="todo-item" data-account="${attr(accountOf(item))}" data-todo-id="${attr(tid)}" onclick="toggleTodo(this)">
      <div class="todo-check"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>
      <div>
        <div class="todo-priority ${attr(item.priority || 'medium')}">${esc(item.priority || 'Medium')}</div>
        <div class="todo-text">${esc(item.text || item.title || item.summary || '')}</div>
        <div class="category-acc">${esc(accountOf(item))}</div>
      </div>
    </div>`;
    }).join('')}</div>
  </section>`;
}

function categorySection(title, items = []) {
  if (!items?.length) return '';
  return `<section class="section">
    ${sectionHeader(title, 'neutral')}
    <div class="category-list">${items.map(item => `<div class="category-item" data-account="${attr(accountOf(item))}">
      <div class="category-sender">${esc(item.senderName || item.sender || item.from || 'Unknown')}</div>
      <div class="category-arrow">&rarr;</div>
      <div>
        <div class="category-detail"><strong>${esc(item.subject || item.title || '(no subject)')}</strong> &mdash; ${esc(item.summary || item.snippet || item.detail || '')}</div>
        ${gmailThreadLink(item, 'View &rarr;', 'category-link')}
        <div class="category-acc">${esc(accountOf(item))}</div>
      </div>
    </div>`).join('')}</div>
  </section>`;
}

function summaryBlock(title, items = []) {
  if (!items?.length) return '';
  return `<section class="section">
    ${sectionHeader(title, 'neutral')}
    <div class="summary-block">
      ${items.map(item => `<div class="summary-row" data-account="${attr(accountOf(item))}">
        <span>${esc(item.sender || item.from || item.title || 'Item')}</span>
        <strong>${esc(item.summary || item.subject || item.detail || '')}</strong>
      </div>`).join('')}
    </div>
  </section>`;
}

function accountTotals() {
  const totals = briefing.accountTotals || buildAccountTotals();
  if (!totals.length) return '';
  return `<section class="section">
    ${sectionHeader('Stats By Account', 'neutral')}
    <table>
      <thead><tr><th>Account</th><th>Total</th><th>Urgent</th><th>Replies</th><th>To-dos</th></tr></thead>
      <tbody>${totals.map(row => `<tr><td>${esc(row.account || row.email)}</td><td>${num(row.total)}</td><td>${num(row.urgent)}</td><td>${num(row.replies)}</td><td>${num(row.todos)}</td></tr>`).join('')}</tbody>
    </table>
  </section>`;
}

function buildAccountTotals() {
  const accounts = briefing.accounts || [];
  return accounts.map(a => {
    const email = a.email;
    const countIn = list => (list || []).filter(i => accountOf(i) === email).length;
    return {
      account: email,
      total: ['urgent', 'business', 'personal', 'financial', 'waiting', 'newsletter', 'spam'].reduce((n, key) => n + countIn(sections[key]), 0),
      urgent: countIn(sections.urgent),
      replies: countIn(sections.suggestedReplies),
      todos: countIn(sections.todos)
    };
  });
}

function sectionHeader(title, marker) {
  return `<div class="section-header"><div class="section-marker ${attr(marker)}"></div><div class="section-title">${esc(title)}</div></div>`;
}

function accountChip(item) {
  const account = accountOf(item);
  return account ? `<span class="account-chip">${esc(accountLabel(account))}</span>` : '';
}

function sourceLine(item) {
  const sender = item.sourceSender || item.sender || item.from;
  const subject = item.sourceSubject || item.subject;
  if (!sender && !subject) return '';
  return `<div class="action-source">Source: ${esc(sender || 'Unknown')} &rarr; ${esc(subject || '(no subject)')}</div>`;
}

function gmailThreadLink(item, label, className) {
  const threadId = item.threadId || item.gmailThreadId;
  if (!threadId) return '';
  const accountEmail = accountOf(item);
  const userPath = accountEmail
    ? encodeURIComponent(accountEmail)
    : (Number.isFinite(item.gmailAccountIndex) ? item.gmailAccountIndex : 0);
  return `<a href="https://mail.google.com/mail/u/${userPath}/#all/${attr(threadId)}" target="_blank" rel="noopener noreferrer" class="${attr(className)}">${label}</a>`;
}

function replyLink(item) {
  const to = item.to || item.replyTo || item.senderEmail || extractEmail(item.sender || item.from) || '';
  const subject = item.replySubject || item.subject || '';
  const body = item.body || item.replyBody || '';
  const url = new URL('https://mail.google.com/mail/');
  url.searchParams.set('view', 'cm');
  url.searchParams.set('fs', '1');
  url.searchParams.set('to', to);
  url.searchParams.set('su', subject);
  url.searchParams.set('body', body);
  return url.toString();
}

function calendarCreateLink(item, calendarId) {
  const url = new URL('https://calendar.google.com/calendar/render');
  url.searchParams.set('action', 'TEMPLATE');
  url.searchParams.set('text', item.title || 'New event');
  url.searchParams.set('dates', `${compactDateTime(item.start)}/${compactDateTime(item.end || item.start)}`);
  url.searchParams.set('details', item.details || item.context || item.source || '');
  url.searchParams.set('location', item.location || '');
  url.searchParams.set('src', calendarId || 'primary');
  return url.toString();
}

function calendarEventLink(ev) {
  if (!ev.title || !ev.start) return '';
  return calendarCreateLink(ev, ev.calendarId || 'primary');
}

function css() {
  return `
:root { --bg:#FAFAF5; --surface:#FFFFFF; --border:#E5E2D6; --text:#1C1B19; --muted:#8A8780; --accent:#A8843A; --urgent:#B83A3A; --calendar:#3A7556; --reply:#3D5DAA; --shadow:0 12px 40px rgba(28,27,25,.07); }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif; }
.topbar { position:sticky; top:0; z-index:10; display:flex; justify-content:space-between; align-items:center; padding:14px 28px; background:rgba(250,250,245,.92); border-bottom:1px solid var(--border); backdrop-filter:blur(14px); }
.kicker, .top-meta, .build-meta, .category-acc, .action-source { font-family:"JetBrains Mono",monospace; font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
.top-title { font-family:"Instrument Serif",Georgia,serif; font-size:26px; }
.top-meta { display:flex; gap:10px; align-items:center; }
.top-meta span { border:1px solid var(--border); border-radius:999px; padding:7px 10px; background:var(--surface); }
main { width:min(1120px, calc(100% - 32px)); margin:28px auto 48px; }
.hero { display:grid; grid-template-columns:1fr auto; gap:24px; align-items:end; padding:22px 0 26px; border-bottom:1px solid var(--border); }
h1 { margin:0 0 6px; font-family:"Instrument Serif",Georgia,serif; font-weight:400; font-size:clamp(42px, 6vw, 72px); line-height:.95; }
.hero p { margin:0; color:var(--muted); max-width:640px; }
.build-meta { display:grid; gap:4px; text-align:right; }
.build-meta strong { color:var(--text); font-family:Inter,sans-serif; font-size:13px; text-transform:none; letter-spacing:0; }
.stale { margin-bottom:18px; padding:12px 14px; border:1px solid rgba(184,58,58,.35); background:rgba(184,58,58,.08); color:var(--urgent); border-radius:8px; font-weight:600; }
.stats { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:22px 0; }
.stat { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:16px; box-shadow:var(--shadow); }
.stat div { font-size:30px; font-weight:700; }
.stat span { color:var(--muted); font-size:13px; }
.stat.red div { color:var(--urgent); } .stat.green div { color:var(--calendar); } .stat.blue div { color:var(--reply); } .stat.gold div { color:var(--accent); }
.filters { display:flex; gap:8px; flex-wrap:wrap; margin:20px 0 28px; }
.filter, button, select { font:inherit; }
.filter { border:1px solid var(--border); background:var(--surface); color:var(--text); padding:8px 12px; border-radius:999px; cursor:pointer; }
.filter.active { background:var(--text); color:var(--bg); border-color:var(--text); }
.section { margin:34px 0; }
.section-header { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
.section-marker { width:9px; height:24px; border-radius:999px; background:var(--accent); }
.section-marker.urgent { background:var(--urgent); } .section-marker.calendar { background:var(--calendar); } .section-marker.reply { background:var(--reply); } .section-marker.todo { background:var(--accent); }
.section-title { font-family:"Instrument Serif",Georgia,serif; font-size:30px; }
.card-grid, .action-list, .todo-list, .category-list { display:grid; gap:12px; }
.email-card, .action-card, .category-item, .todo-item, .summary-block, table { background:var(--surface); border:1px solid var(--border); border-radius:8px; box-shadow:var(--shadow); }
.email-card, .action-card { padding:16px; }
.email-card.urgent { border-color:rgba(184,58,58,.3); }
.account-chip { display:inline-flex; width:max-content; margin-bottom:10px; padding:4px 8px; border-radius:999px; background:rgba(168,132,58,.12); color:var(--accent); font-size:11px; font-weight:700; }
.email-from, .category-sender { font-weight:700; }
.email-subject, .action-title { margin-top:4px; font-size:18px; font-weight:700; }
.email-summary, .action-detail, .reply-preview { margin-top:8px; color:#4C4943; line-height:1.5; }
.email-meta, .action-buttons { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:12px; }
.email-tag, .action-btn, .category-link, .schedule-link { display:inline-flex; align-items:center; justify-content:center; min-height:34px; padding:7px 10px; border-radius:7px; border:1px solid var(--border); background:var(--surface); color:var(--text); text-decoration:none; font-size:13px; font-weight:600; cursor:pointer; }
.email-tag.deadline { color:var(--urgent); border-color:rgba(184,58,58,.3); }
.link-tag { color:var(--reply); }
.action-btn.primary { background:var(--text); color:var(--bg); border-color:var(--text); }
.action-type { font-size:12px; font-weight:800; text-transform:uppercase; color:var(--accent); }
.action-type.cal { color:var(--calendar); } .action-type.rep { color:var(--reply); }
.calendar-select { min-height:34px; border:1px solid var(--border); border-radius:7px; background:var(--surface); padding:0 8px; }
.schedule-group-title { margin:18px 0 8px; color:var(--muted); font-weight:700; text-transform:uppercase; font-size:12px; }
.schedule-event { display:grid; grid-template-columns:150px 1fr auto; gap:14px; align-items:center; padding:14px 0; border-bottom:1px solid var(--border); }
.schedule-event:last-child { border-bottom:0; }
.schedule-time { font-weight:700; color:#4C4943; }
.schedule-title { font-weight:800; }
.schedule-calendar, .schedule-location { margin-top:4px; font-size:13px; color:var(--muted); }
.no-events { padding:18px; color:var(--muted); background:var(--surface); border:1px dashed var(--border); border-radius:8px; }
.todo-item { display:grid; grid-template-columns:24px 1fr; gap:12px; padding:14px; cursor:pointer; }
.todo-check { width:22px; height:22px; border-radius:50%; border:1px solid var(--border); display:grid; place-items:center; background:var(--surface); }
.todo-check svg { opacity:0; }
.todo-item.checked .todo-check { background:var(--calendar); border-color:var(--calendar); }
.todo-item.checked .todo-check svg { opacity:1; }
.todo-item.checked .todo-text { text-decoration:line-through; color:var(--muted); }
.todo-priority { width:max-content; margin-bottom:4px; padding:2px 7px; border-radius:999px; font-size:11px; font-weight:800; color:var(--accent); background:rgba(168,132,58,.12); text-transform:uppercase; }
.todo-priority.high { color:var(--urgent); background:rgba(184,58,58,.1); }
.todo-priority.low { color:var(--calendar); background:rgba(58,117,86,.1); }
.category-item { display:grid; grid-template-columns:180px 24px 1fr; gap:10px; padding:14px; align-items:start; }
.category-arrow { color:var(--muted); }
.category-detail { line-height:1.45; }
.summary-block { padding:8px 14px; }
.summary-row { display:grid; grid-template-columns:190px 1fr; gap:12px; padding:10px 0; border-bottom:1px solid var(--border); }
.summary-row:last-child { border-bottom:0; }
.summary-row span { color:var(--muted); }
table { width:100%; border-collapse:collapse; overflow:hidden; }
th, td { text-align:left; padding:12px; border-bottom:1px solid var(--border); }
th { color:var(--muted); font-size:12px; text-transform:uppercase; }
footer { width:min(1120px, calc(100% - 32px)); margin:0 auto 32px; color:var(--muted); font-size:13px; }
.hidden-by-filter { display:none !important; }
@media (max-width:760px) { .topbar, .hero, .stats, .schedule-event, .category-item, .summary-row { grid-template-columns:1fr; } .topbar { align-items:flex-start; gap:10px; } .build-meta { text-align:left; } .stats { gap:8px; } h1 { font-size:46px; } .schedule-link { width:max-content; } }
`;
}

function clientJs() {
  return `
function filterAccount(account, btn) {
  document.querySelectorAll('.filter').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.querySelectorAll('[data-account]').forEach(el => {
    const show = account === 'all' || el.dataset.account === account;
    el.classList.toggle('hidden-by-filter', !show);
  });
}
function updateCalLink(eventId, calId, selectEl) {
  const link = document.getElementById('cal-link-' + eventId);
  if (link) {
    const url = new URL(link.href);
    url.searchParams.set('src', calId);
    link.href = url.toString();
  }
  const card = document.getElementById(eventId);
  if (card && selectEl) {
    card.dataset.eventCalendar = selectEl.options[selectEl.selectedIndex].dataset.calName;
  }
}
function addToSchedule(linkEl) {
  const card = linkEl.closest('.action-card');
  const title = card.dataset.eventTitle;
  const startISO = card.dataset.eventStart;
  const endISO = card.dataset.eventEnd;
  const location = card.dataset.eventLocation || '';
  const select = card.querySelector('.calendar-select');
  const calName = select ? select.options[select.selectedIndex].dataset.calName : card.dataset.eventCalendar;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const eventDate = new Date(startISO);
  if (eventDate.toDateString() !== tomorrow.toDateString()) return;
  const startTime = new Date(startISO).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const endTime = new Date(endISO).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const newEvent = document.createElement('div');
  newEvent.className = 'schedule-event schedule-event-added';
  newEvent.innerHTML = '<div class="schedule-time">' + escapeText(startTime + ' - ' + endTime) + '</div>'
    + '<div class="schedule-info">'
    + '<div class="schedule-title">' + escapeText(title) + '</div>'
    + '<div class="schedule-calendar">● ' + escapeText(calName) + ' (just added)</div>'
    + (location ? '<div class="schedule-location">' + escapeText(location) + '</div>' : '')
    + '</div>';
  const scheduleSection = document.getElementById('tomorrow-schedule');
  if (!scheduleSection) return;
  const noEvents = scheduleSection.querySelector('.no-events');
  if (noEvents) noEvents.remove();
  const existing = scheduleSection.querySelectorAll('.schedule-event');
  let inserted = false;
  for (const ev of existing) {
    const evTimeText = ev.querySelector('.schedule-time').textContent;
    if (startTime < evTimeText) {
      scheduleSection.insertBefore(newEvent, ev);
      inserted = true;
      break;
    }
  }
  if (!inserted) scheduleSection.appendChild(newEvent);
  newEvent.style.transition = 'background 0.5s ease';
  newEvent.style.background = 'rgba(58,117,86,0.12)';
  setTimeout(() => { newEvent.style.background = 'transparent'; }, 2000);
  card.style.opacity = '0.5';
  card.querySelector('.action-buttons').innerHTML = '<div style="color: var(--calendar); font-size: 13px; font-weight: 500;">Added to calendar and schedule</div>';
}
function escapeText(value) {
  return String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function toggleTodo(el) {
  el.classList.toggle('checked');
  var tid = el.dataset.todoId;
  if (!tid) return;
  try {
    var stored = JSON.parse(localStorage.getItem('briefing-todos') || '{}');
    if (el.classList.contains('checked')) { stored[tid] = true; } else { delete stored[tid]; }
    localStorage.setItem('briefing-todos', JSON.stringify(stored));
  } catch (e) {}
}
(function restoreTodos() {
  try {
    var stored = JSON.parse(localStorage.getItem('briefing-todos') || '{}');
    document.querySelectorAll('.todo-item[data-todo-id]').forEach(function(el) {
      if (stored[el.dataset.todoId]) el.classList.add('checked');
    });
  } catch (e) {}
})();
`;
}

function defaultCalendars() {
  return [{ id: 'primary', name: 'Primary calendar', color: '#3A7556' }];
}

function accountOf(item) {
  return item?.account || item?.sourceAccount || item?.originalRecipient || '';
}

function accountLabel(email) {
  const found = (briefing.accounts || []).find(a => a.email === email);
  return found?.label || email;
}

function calendarName(id) {
  return calendars.find(c => c.id === id)?.name || calendars[0]?.name || 'Calendar';
}

function calendarColor(name) {
  const colors = ['#3A7556', '#3D5DAA', '#A8843A', '#8F4D67', '#5F6F52'];
  let hash = 0;
  for (const ch of String(name || 'calendar')) hash = (hash + ch.charCodeAt(0)) % colors.length;
  return colors[hash];
}

function timeRange(start, end, allDay) {
  if (allDay) return 'All day';
  if (!start) return 'Time TBD';
  return `${formatTime(start)} - ${formatTime(end || start)}`;
}

function dateRange(start, end) {
  if (!start) return 'Date TBD';
  return `${formatDateTime(start)}${end ? ` - ${formatTime(end)}` : ''}`;
}

function formatTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || '');
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || '');
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

function localISODate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${obj.year}-${obj.month}-${obj.day}`;
}

function hourOf(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 12 : d.getHours();
}

function compactDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function extractEmail(value) {
  return String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function attr(value) {
  return esc(value).replace(/`/g, '&#96;');
}

function jsStr(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}

function num(value) {
  return Number(value || 0);
}
