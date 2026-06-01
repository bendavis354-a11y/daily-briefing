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

// ── tab badge counts ────────────────────────────────────────────────────────
const emailCount = [sections.urgent, sections.business, sections.personal, sections.financial, sections.waiting]
  .reduce((n, arr) => n + (arr?.length || 0), 0);
const taskCount = sections.todos?.length || 0;
const calCount = sections.tomorrowSchedule?.length || 0;
const suggCount = (sections.calendarProposals?.length || 0) + (sections.suggestedReplies?.length || 0);
const fyiCount = (sections.newsletter?.length || 0) + (sections.spam?.length || 0);

function badge(n) {
  return n ? `<span class="tab-badge">${n}</span>` : '';
}

// ── greeting ────────────────────────────────────────────────────────────────
function greeting() {
  const h = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: briefing.metadata.timezone || 'America/New_York',
    hour: 'numeric', hour12: false
  }).format(new Date()));
  if (h < 12) return 'Good morning, Ben';
  if (h < 17) return 'Good afternoon, Ben';
  return 'Good evening, Ben';
}

// ── HTML ────────────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Briefing</title>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>${css()}</style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-brand">
      <div class="kicker">Ben Assistant</div>
      <div class="top-title">Daily Briefing</div>
    </div>
    <div class="topbar-meta">
      <span class="meta-pill">${esc(briefing.metadata.date)}</span>
      <span class="meta-pill">${actionCount()} actions</span>
    </div>
  </header>

  <nav class="workspace-nav" role="navigation" aria-label="Workspace tabs">
    <button class="tab-btn active" data-tab="today" onclick="switchTab('today',this)">Today</button>
    <button class="tab-btn" data-tab="email" onclick="switchTab('email',this)">Email${badge(emailCount)}</button>
    <button class="tab-btn" data-tab="tasks" onclick="switchTab('tasks',this)">Tasks${badge(taskCount)}</button>
    <button class="tab-btn" data-tab="calendar" onclick="switchTab('calendar',this)">Calendar${badge(calCount)}</button>
    <button class="tab-btn" data-tab="suggestions" onclick="switchTab('suggestions',this)">Suggestions${badge(suggCount)}</button>
    <button class="tab-btn" data-tab="fyi" onclick="switchTab('fyi',this)">FYI${badge(fyiCount)}</button>
  </nav>

  <main>
    ${isStale ? staleWarning() : ''}

    <div id="tab-today" class="tab-panel active">
      ${todayPanel()}
    </div>

    <div id="tab-email" class="tab-panel">
      ${emailPanel()}
    </div>

    <div id="tab-tasks" class="tab-panel">
      ${tasksPanel()}
    </div>

    <div id="tab-calendar" class="tab-panel">
      ${calendarPanel()}
    </div>

    <div id="tab-suggestions" class="tab-panel">
      ${suggestionsPanel()}
    </div>

    <div id="tab-fyi" class="tab-panel">
      ${fyiPanel()}
    </div>
  </main>

  <footer>No emails sent automatically. Replies open Gmail compose; Ben writes and sends.</footer>
  <script>${clientJs()}</script>
</body>
</html>`;

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync(outPath, html);
console.log(`Rendered ${outPath}`);

// ── tab panels ───────────────────────────────────────────────────────────────

function todayPanel() {
  const todayUrgent = sections.urgent || [];
  const schedulePreview = (sections.tomorrowSchedule || []).slice(0, 4);
  const todoPreview = (sections.todos || []).slice(0, 3);

  return `
    <section class="today-hero">
      <div class="hero-text">
        <h1>${esc(greeting())}</h1>
        <p class="hero-summary">${esc(summaryLine())}</p>
      </div>
      <div class="build-meta">
        <div>Generated</div>
        <strong>${esc(formatDateTime(briefing.metadata.generatedAt))}</strong>
        <div>Fresh through</div>
        <strong>${esc(formatDateTime(briefing.metadata.dataFreshThrough))}</strong>
      </div>
    </section>

    ${statsRow()}

    ${todayUrgent.length ? `
    <section class="today-block">
      ${sectionHeader('Needs Attention', 'urgent')}
      <div class="card-grid compact">
        ${todayUrgent.map(item => emailCardCompact(item, 'urgent')).join('')}
      </div>
    </section>` : ''}

    <section class="today-two-col">
      <div class="today-col">
        ${sectionHeader(briefing.metadata.tomorrowLabel || 'Tomorrow', 'calendar')}
        ${schedulePreview.length
          ? `<div class="schedule-list">${schedulePreview.map(scheduleEventCompact).join('')}</div>
             ${(sections.tomorrowSchedule || []).length > 4
               ? `<button class="see-more-btn" onclick="switchTab('calendar',document.querySelector('[data-tab=calendar]'))">See all ${(sections.tomorrowSchedule || []).length} events &rarr;</button>` : ''}`
          : `<div class="no-data">No events tomorrow</div>`}
      </div>
      <div class="today-col">
        ${sectionHeader('Open Tasks', 'todo')}
        ${todoPreview.length
          ? `<div class="todo-list">${todoPreview.map(item => todoItem(item)).join('')}</div>
             ${taskCount > 3
               ? `<button class="see-more-btn" onclick="switchTab('tasks',document.querySelector('[data-tab=tasks]'))">See all ${taskCount} tasks &rarr;</button>` : ''}`
          : `<div class="no-data">No open tasks</div>`}
      </div>
    </section>`;
}

function emailPanel() {
  const hasEmail = emailCount > 0;
  return `
    ${accountFilters()}
    ${!hasEmail ? `<div class="no-data large">No email needs attention.</div>` : ''}
    ${emailCards('Urgent', 'urgent', sections.urgent, 'urgent')}
    ${categorySection('Business', sections.business)}
    ${categorySection('Personal', sections.personal)}
    ${categorySection('Financial', sections.financial)}
    ${categorySection('Waiting / FYI', sections.waiting)}`;
}

function tasksPanel() {
  const todos = sections.todos || [];
  if (!todos.length) {
    return `<div class="no-data large">No open tasks. Nice work.</div>`;
  }
  return `
    <section class="section">
      ${sectionHeader('To-do List', 'todo')}
      <div class="todo-list full">${todos.map(item => todoItem(item)).join('')}</div>
    </section>`;
}

function calendarPanel() {
  const week = sections.weekSchedule || [];
  return `
    ${scheduleSection(sections.tomorrowSchedule)}
    ${weekScheduleSection(week)}`;
}

function suggestionsPanel() {
  const hasAny = (sections.calendarProposals?.length || 0) + (sections.suggestedReplies?.length || 0) > 0;
  if (!hasAny) {
    return `<div class="no-data large">No suggestions today.</div>`;
  }
  return `
    ${calendarProposalSection(sections.calendarProposals)}
    ${replySection(sections.suggestedReplies)}`;
}

function fyiPanel() {
  return `
    ${summaryBlock('Newsletter / Info', sections.newsletter)}
    ${summaryBlock('Spam / Junk', sections.spam)}
    ${accountTotals()}`;
}

// ── section renderers ────────────────────────────────────────────────────────

function statsRow() {
  const s = briefing.stats || {};
  return `<section class="stats-row">
    ${stat('Urgent', s.urgent, 'red')}
    ${stat('Events Tomorrow', s.eventsTomorrow, 'green')}
    ${stat('Replies', s.suggestedReplies, 'blue')}
    ${stat('To-dos', s.todos, 'gold')}
  </section>`;
}

function stat(label, value, tone) {
  return `<div class="stat ${tone}"><div class="stat-num">${num(value)}</div><span>${esc(label)}</span></div>`;
}

function staleWarning() {
  return `<div class="stale">This briefing may be stale. Expected ${esc(todayISO)}, but the page was built for ${esc(briefing.metadata.date)}. Last successful build: ${esc(formatDateTime(briefing.metadata.lastSuccessfulBuildAt))}.</div>`;
}

function accountFilters() {
  const accounts = briefing.accounts || [];
  if (!accounts.length) return '';
  return `<nav class="filters" aria-label="Filter by account">
    <button class="filter active" data-filter="all" onclick="filterAccount('all',this)">All</button>
    ${accounts.map(a => `<button class="filter" data-filter="${attr(a.email)}" onclick="filterAccount('${jsStr(a.email)}',this)">${esc(a.label || a.email)}</button>`).join('')}
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
          ${gmailThreadLink(item, 'View Thread &rarr;', 'email-tag link-tag')}
        </div>
      </article>`).join('')}
    </div>
  </section>`;
}

function emailCardCompact(item, className = '') {
  return `<article class="email-card ${attr(className)}" data-account="${attr(accountOf(item))}">
    ${accountChip(item)}
    <div class="email-from">${esc(item.senderName || item.sender || item.from || 'Unknown sender')}</div>
    <div class="email-subject">${esc(item.subject || item.title || '(no subject)')}</div>
    <div class="email-summary">${esc((item.summary || item.snippet || item.detail || '').slice(0, 120))}</div>
    <div class="email-meta">
      ${gmailThreadLink(item, 'View Thread &rarr;', 'email-tag link-tag')}
    </div>
  </article>`;
}

function categorySection(title, items = []) {
  if (!items?.length) return '';
  return `<section class="section">
    ${sectionHeader(title, 'neutral')}
    <div class="category-list">${items.map(item => `<div class="category-item" data-account="${attr(accountOf(item))}">
      <div class="category-sender">${esc(item.senderName || item.sender || item.from || 'Unknown')}</div>
      <div class="category-arrow">&rarr;</div>
      <div class="category-body">
        <div class="category-detail"><strong>${esc(item.subject || item.title || '(no subject)')}</strong>${item.summary || item.snippet ? ` &mdash; ${esc((item.summary || item.snippet || '').slice(0, 140))}` : ''}</div>
        <div class="category-footer">
          ${gmailThreadLink(item, 'View Thread', 'category-link')}
          <span class="category-acc">${esc(accountLabel(accountOf(item)))}</span>
        </div>
      </div>
    </div>`).join('')}</div>
  </section>`;
}

function scheduleSection(events = []) {
  const sorted = [...(events || [])].sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
  return `<section class="section">
    ${sectionHeader("Tomorrow's Schedule", 'calendar')}
    <div id="tomorrow-schedule">
      ${sorted.length
        ? sorted.map(scheduleEvent).join('')
        : `<div class="no-data">No events scheduled for tomorrow.</div>`}
    </div>
  </section>`;
}

function weekScheduleSection(events = []) {
  const evts = events || [];
  const header = sectionHeader('This Week', 'calendar');

  if (!evts.length) {
    return `<section class="section">
      ${header}
      <div class="no-data">Week schedule not available. The daily gather scans tomorrow only; a 7-day calendar scan would populate this section.</div>
    </section>`;
  }

  const byDate = {};
  for (const ev of evts) {
    const key = (ev.start || 'unknown').slice(0, 10);
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(ev);
  }

  const days = Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b));
  return `<section class="section">
    ${header}
    ${days.map(([date, dayEvents]) => `
      <div class="week-day">
        <div class="week-day-label">${esc(formatWeekdayLabel(date))}</div>
        <div class="week-day-events">${dayEvents.map(scheduleEvent).join('')}</div>
      </div>`).join('')}
  </section>`;
}

function scheduleEvent(ev) {
  const color = ev.color || calendarColor(ev.calendarName || ev.calendarId);
  const link = ev.htmlLink || calendarEventLink(ev);
  return `<div class="schedule-event">
    <div class="schedule-time">${esc(timeRange(ev.start, ev.end, ev.allDay))}</div>
    <div class="schedule-info">
      <div class="schedule-title">${esc(ev.title || ev.summary || '(no title)')}</div>
      <div class="schedule-calendar" style="color:${attr(color)}">&#9679; ${esc(ev.calendarName || 'Calendar')}</div>
      ${ev.location ? `<div class="schedule-location">${esc(ev.location)}</div>` : ''}
    </div>
    ${link ? `<a href="${attr(link)}" target="_blank" rel="noopener noreferrer" class="schedule-link">Open &rarr;</a>` : ''}
  </div>`;
}

function scheduleEventCompact(ev) {
  const color = ev.color || calendarColor(ev.calendarName || ev.calendarId);
  return `<div class="schedule-event compact">
    <div class="schedule-time">${esc(timeRange(ev.start, ev.end, ev.allDay))}</div>
    <div class="schedule-info">
      <div class="schedule-title">${esc(ev.title || ev.summary || '(no title)')}</div>
      <div class="schedule-calendar" style="color:${attr(color)}">&#9679; ${esc(ev.calendarName || 'Calendar')}</div>
    </div>
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
      <select class="calendar-select" onchange="updateCalLink('${jsStr(id)}',this.value,this)" data-calendars>
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
      ${item.body || item.replyBody ? `<div class="reply-preview">${esc(item.body || item.replyBody)}</div>` : ''}
      <div class="action-buttons">
        <a href="${attr(replyLink(item))}" target="_blank" rel="noopener noreferrer" class="action-btn primary">Reply in Gmail</a>
        ${gmailThreadLink(item, 'View Thread', 'action-btn')}
        <button class="action-btn" onclick="this.closest('.action-card').style.display='none'">Skip</button>
      </div>
    </div>`).join('')}</div>
  </section>`;
}

function todoItem(item) {
  const tid = makeTodoId(item);
  return `<div class="todo-item" data-account="${attr(accountOf(item))}" data-todo-id="${attr(tid)}" onclick="toggleTodo(this)">
    <div class="todo-check"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>
    <div class="todo-body">
      <div class="todo-priority ${attr(item.priority || 'medium')}">${esc(item.priority || 'Medium')}</div>
      <div class="todo-text">${esc(item.text || item.title || item.summary || '')}</div>
      <div class="todo-account">${esc(accountLabel(accountOf(item)))}</div>
    </div>
  </div>`;
}

function summaryBlock(title, items = []) {
  if (!items?.length) return '';
  return `<section class="section">
    ${sectionHeader(title, 'neutral')}
    <div class="summary-block">
      ${items.map(item => `<div class="summary-row" data-account="${attr(accountOf(item))}">
        <span class="summary-sender">${esc(item.senderName || item.sender || item.from || item.title || 'Item')}</span>
        <span class="summary-text">${esc(item.summary || item.subject || item.detail || '')}</span>
      </div>`).join('')}
    </div>
  </section>`;
}

function accountTotals() {
  const totals = buildAccountTotals();
  if (!totals.length) return '';
  return `<section class="section">
    ${sectionHeader('Stats by Account', 'neutral')}
    <div class="table-wrap">
      <table>
        <thead><tr><th>Account</th><th>Total</th><th>Urgent</th><th>Replies</th><th>To-dos</th></tr></thead>
        <tbody>${totals.map(row => `<tr><td>${esc(row.account)}</td><td>${num(row.total)}</td><td>${num(row.urgent)}</td><td>${num(row.replies)}</td><td>${num(row.todos)}</td></tr>`).join('')}</tbody>
      </table>
    </div>
  </section>`;
}

// ── shared helpers ───────────────────────────────────────────────────────────

function sectionHeader(title, marker) {
  return `<div class="section-header"><div class="section-marker ${attr(marker)}"></div><h2 class="section-title">${esc(title)}</h2></div>`;
}

function accountChip(item) {
  const account = accountOf(item);
  return account ? `<span class="account-chip">${esc(accountLabel(account))}</span>` : '';
}

function sourceLine(item) {
  const sender = item.sourceSender || item.sender || item.from;
  const subject = item.sourceSubject || item.subject;
  if (!sender && !subject) return '';
  return `<div class="action-source">From: ${esc(sender || 'Unknown')} &rarr; ${esc(subject || '(no subject)')}</div>`;
}

function gmailThreadLink(item, label, className) {
  const sourceAccount = item.sourceAccount || item.account || item.originalRecipient || '';

  let threadId = null;
  if (Array.isArray(item.gmailLinks) && item.gmailLinks.length) {
    const match = item.gmailLinks.find(l => l.sourceAccount === sourceAccount) || item.gmailLinks[0];
    if (match) threadId = match.gmailThreadId;
  }
  if (!threadId) threadId = item.gmailThreadId || item.threadId;
  if (!threadId) return '';

  const authuser = sourceAccount ? `?authuser=${encodeURIComponent(sourceAccount)}` : '';
  const url = `https://mail.google.com/mail/${authuser}#all/${threadId}`;
  return `<a href="${attr(url)}" target="ben-gmail-thread" rel="noopener noreferrer" class="${attr(className)}">${label}</a>`;
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

function makeTodoId(item) {
  const raw = [item.id || '', item.conversationKey || '', item.text || item.title || item.summary || '', accountOf(item)].join('\x00');
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0;
  return 'todo_' + (h >>> 0).toString(36);
}

function buildAccountTotals() {
  const accounts = briefing.accounts || [];
  return accounts.map(a => {
    const email = a.email;
    const countIn = list => (list || []).filter(i => accountOf(i) === email).length;
    return {
      account: a.label || email,
      total: ['urgent', 'business', 'personal', 'financial', 'waiting', 'newsletter', 'spam'].reduce((n, key) => n + countIn(sections[key]), 0),
      urgent: countIn(sections.urgent),
      replies: countIn(sections.suggestedReplies),
      todos: countIn(sections.todos)
    };
  });
}

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

// ── CSS ──────────────────────────────────────────────────────────────────────

function css() {
  return `
:root {
  --bg: #FAFAF5;
  --surface: #FFFFFF;
  --border: #E5E2D6;
  --text: #1C1B19;
  --muted: #8A8780;
  --accent: #A8843A;
  --urgent: #B83A3A;
  --calendar: #3A7556;
  --reply: #3D5DAA;
  --shadow: 0 2px 12px rgba(28,27,25,.06);
  --topbar-h: 56px;
  --nav-h: 44px;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 15px;
  line-height: 1.5;
}

/* ── topbar ─────────────────────────────── */
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  height: var(--topbar-h);
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 24px;
  background: rgba(250,250,245,.94);
  border-bottom: 1px solid var(--border);
  backdrop-filter: blur(14px);
}
.kicker {
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: .06em;
  margin-bottom: 1px;
}
.top-title {
  font-family: "Instrument Serif", Georgia, serif;
  font-size: 20px;
  line-height: 1;
}
.topbar-meta { display: flex; gap: 8px; }
.meta-pill {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 5px 10px;
  background: var(--surface);
  color: var(--muted);
}

/* ── workspace nav ──────────────────────── */
.workspace-nav {
  position: sticky;
  top: var(--topbar-h);
  z-index: 19;
  display: flex;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  scrollbar-width: none;
  padding: 0 16px;
}
.workspace-nav::-webkit-scrollbar { display: none; }
.tab-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 16px;
  height: var(--nav-h);
  border: none;
  background: none;
  color: var(--muted);
  font: 600 13px Inter, sans-serif;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
  transition: color .15s, border-color .15s;
}
.tab-btn:hover { color: var(--text); }
.tab-btn.active { color: var(--text); border-bottom-color: var(--text); }
.tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  font-weight: 800;
}
.tab-btn.active .tab-badge { background: var(--text); }

/* ── main / panels ──────────────────────── */
main {
  width: min(1100px, calc(100% - 32px));
  margin: 0 auto;
  padding-bottom: 60px;
}
.tab-panel { display: none; padding-top: 28px; }
.tab-panel.active { display: block; }
.stale {
  margin-bottom: 20px;
  padding: 12px 14px;
  border: 1px solid rgba(184,58,58,.3);
  background: rgba(184,58,58,.07);
  color: var(--urgent);
  border-radius: 8px;
  font-weight: 600;
  font-size: 13px;
}

/* ── today tab ──────────────────────────── */
.today-hero {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 24px;
  align-items: end;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 24px;
}
h1 {
  font-family: "Instrument Serif", Georgia, serif;
  font-weight: 400;
  font-size: clamp(36px, 5vw, 60px);
  line-height: 1;
  margin-bottom: 8px;
}
.hero-summary { color: var(--muted); max-width: 560px; }
.build-meta {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: .04em;
  display: grid;
  gap: 3px;
  text-align: right;
}
.build-meta strong {
  color: var(--text);
  font-family: Inter, sans-serif;
  font-size: 12px;
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
}
.stats-row {
  display: grid;
  grid-template-columns: repeat(4,1fr);
  gap: 10px;
  margin-bottom: 28px;
}
.stat {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  box-shadow: var(--shadow);
}
.stat-num { font-size: 28px; font-weight: 700; margin-bottom: 2px; }
.stat span { color: var(--muted); font-size: 12px; }
.stat.red .stat-num { color: var(--urgent); }
.stat.green .stat-num { color: var(--calendar); }
.stat.blue .stat-num { color: var(--reply); }
.stat.gold .stat-num { color: var(--accent); }
.today-block { margin-bottom: 28px; }
.today-two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  margin-top: 8px;
}
.today-col {}
.see-more-btn {
  margin-top: 10px;
  font: 600 12px Inter, sans-serif;
  color: var(--reply);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}
.see-more-btn:hover { text-decoration: underline; }
.no-data {
  color: var(--muted);
  font-size: 14px;
  padding: 14px 0;
}
.no-data.large {
  text-align: center;
  padding: 60px 0;
  font-size: 16px;
}

/* ── sections ───────────────────────────── */
.section { margin: 32px 0; }
.section-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.section-marker {
  width: 8px;
  height: 22px;
  border-radius: 999px;
  background: var(--accent);
  flex-shrink: 0;
}
.section-marker.urgent { background: var(--urgent); }
.section-marker.calendar { background: var(--calendar); }
.section-marker.reply { background: var(--reply); }
.section-marker.todo { background: var(--accent); }
.section-marker.neutral { background: var(--border); }
h2.section-title {
  font-family: "Instrument Serif", Georgia, serif;
  font-size: 26px;
  font-weight: 400;
}

/* ── account filters ────────────────────── */
.filters {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.filter {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
  padding: 6px 14px;
  border-radius: 999px;
  cursor: pointer;
  font: 500 13px Inter, sans-serif;
  transition: all .15s;
}
.filter:hover { color: var(--text); border-color: var(--text); }
.filter.active { background: var(--text); color: var(--bg); border-color: var(--text); }

/* ── card grid ──────────────────────────── */
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.card-grid.compact { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.email-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  box-shadow: var(--shadow);
}
.email-card.urgent { border-color: rgba(184,58,58,.3); }
.account-chip {
  display: inline-flex;
  margin-bottom: 10px;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(168,132,58,.12);
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
}
.email-from { font-weight: 700; font-size: 14px; }
.email-subject { margin-top: 3px; font-size: 16px; font-weight: 700; line-height: 1.3; }
.email-summary { margin-top: 6px; color: #4C4943; font-size: 13px; line-height: 1.5; }
.email-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.email-tag, .action-btn, .category-link, .schedule-link {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  text-decoration: none;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background .15s;
}
.email-tag:hover, .action-btn:hover, .category-link:hover { background: var(--bg); }
.email-tag.deadline { color: var(--urgent); border-color: rgba(184,58,58,.3); }
.link-tag { color: var(--reply); }
.action-btn.primary { background: var(--text); color: var(--bg); border-color: var(--text); }
.action-btn.primary:hover { background: #333; }

/* ── category list ──────────────────────── */
.category-list { display: grid; gap: 1px; background: var(--border); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; box-shadow: var(--shadow); }
.category-item {
  display: grid;
  grid-template-columns: 160px 20px 1fr;
  gap: 10px;
  padding: 12px 14px;
  background: var(--surface);
  align-items: start;
}
.category-sender { font-weight: 700; font-size: 13px; }
.category-arrow { color: var(--muted); }
.category-body {}
.category-detail { font-size: 13px; line-height: 1.4; }
.category-footer { display: flex; gap: 10px; align-items: center; margin-top: 6px; }
.category-acc {
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  color: var(--muted);
}
.category-link { font-size: 11px; min-height: 24px; padding: 3px 8px; }

/* ── schedule ───────────────────────────── */
.schedule-event {
  display: grid;
  grid-template-columns: 160px 1fr auto;
  gap: 14px;
  align-items: center;
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}
.schedule-event:last-child { border-bottom: 0; }
.schedule-event.compact { grid-template-columns: 140px 1fr; padding: 10px 0; }
.schedule-time { font-weight: 700; font-size: 13px; color: #4C4943; }
.schedule-title { font-weight: 700; font-size: 14px; }
.schedule-calendar { margin-top: 3px; font-size: 12px; }
.schedule-location { margin-top: 2px; font-size: 12px; color: var(--muted); }
.week-day { margin-bottom: 24px; }
.week-day-label {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .06em;
  color: var(--muted);
  margin-bottom: 4px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

/* ── action cards ───────────────────────── */
.action-list { display: grid; gap: 12px; }
.action-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  box-shadow: var(--shadow);
}
.action-type { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; color: var(--accent); margin-bottom: 6px; }
.action-type.cal { color: var(--calendar); }
.action-type.rep { color: var(--reply); }
.action-title { font-size: 17px; font-weight: 700; line-height: 1.3; }
.action-detail { margin-top: 6px; color: #4C4943; font-size: 13px; line-height: 1.45; }
.action-source {
  margin-top: 8px;
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  color: var(--muted);
}
.reply-preview {
  margin-top: 10px;
  padding: 10px 12px;
  background: var(--bg);
  border-radius: 6px;
  border: 1px solid var(--border);
  font-size: 13px;
  line-height: 1.5;
  color: #4C4943;
  white-space: pre-line;
}
.action-buttons { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 14px; }
.calendar-select {
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  padding: 0 8px;
  font: inherit;
  font-size: 12px;
}

/* ── todos ──────────────────────────────── */
.todo-list { display: grid; gap: 6px; }
.todo-list.full {}
.todo-item {
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: 12px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  box-shadow: var(--shadow);
  transition: opacity .2s;
}
.todo-check {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid var(--border);
  display: grid;
  place-items: center;
  background: var(--surface);
  margin-top: 2px;
  flex-shrink: 0;
  transition: all .15s;
}
.todo-check svg { opacity: 0; transition: opacity .15s; }
.todo-item.checked .todo-check { background: var(--calendar); border-color: var(--calendar); }
.todo-item.checked .todo-check svg { opacity: 1; }
.todo-item.checked .todo-text { text-decoration: line-through; color: var(--muted); }
.todo-priority {
  display: inline-flex;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: .04em;
  color: var(--accent);
  background: rgba(168,132,58,.12);
  margin-bottom: 4px;
}
.todo-priority.high { color: var(--urgent); background: rgba(184,58,58,.1); }
.todo-priority.low { color: var(--calendar); background: rgba(58,117,86,.1); }
.todo-text { font-size: 14px; line-height: 1.4; }
.todo-account { font-family: "JetBrains Mono", monospace; font-size: 10px; color: var(--muted); margin-top: 3px; }

/* ── fyi ────────────────────────────────── */
.summary-block {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: var(--shadow);
}
.summary-row {
  display: grid;
  grid-template-columns: 180px 1fr;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.summary-row:last-child { border-bottom: 0; }
.summary-sender { color: var(--muted); font-size: 12px; }
.summary-text { color: var(--text); }
.table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; box-shadow: var(--shadow); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
tr:last-child td { border-bottom: 0; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }

/* ── footer ─────────────────────────────── */
footer {
  width: min(1100px, calc(100% - 32px));
  margin: 0 auto 32px;
  color: var(--muted);
  font-size: 12px;
  border-top: 1px solid var(--border);
  padding-top: 16px;
}

/* ── utility ────────────────────────────── */
.hidden-by-filter { display: none !important; }

/* ── mobile ─────────────────────────────── */
@media (max-width: 700px) {
  .today-hero { grid-template-columns: 1fr; }
  .build-meta { text-align: left; }
  .stats-row { grid-template-columns: repeat(2, 1fr); }
  .today-two-col { grid-template-columns: 1fr; }
  .card-grid { grid-template-columns: 1fr; }
  .category-item { grid-template-columns: 1fr; }
  .category-arrow { display: none; }
  .schedule-event { grid-template-columns: 1fr; gap: 6px; }
  .schedule-event.compact { grid-template-columns: 1fr; }
  .summary-row { grid-template-columns: 1fr; }
  .topbar { padding: 0 16px; }
  .workspace-nav { padding: 0 8px; }
  .tab-btn { padding: 0 12px; font-size: 12px; }
  main { width: calc(100% - 24px); }
}
`;
}

// ── client JS ────────────────────────────────────────────────────────────────

function clientJs() {
  return `
function switchTab(tabId, btn) {
  document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
  var panel = document.getElementById('tab-' + tabId);
  if (panel) panel.classList.add('active');
}

function filterAccount(account, btn) {
  var emailTab = document.getElementById('tab-email');
  if (!emailTab) return;
  emailTab.querySelectorAll('.filter').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  emailTab.querySelectorAll('[data-account]').forEach(function(el) {
    var show = account === 'all' || el.dataset.account === account;
    el.classList.toggle('hidden-by-filter', !show);
  });
}

function updateCalLink(eventId, calId, selectEl) {
  var link = document.getElementById('cal-link-' + eventId);
  if (link) {
    var url = new URL(link.href);
    url.searchParams.set('src', calId);
    link.href = url.toString();
  }
  var card = document.getElementById(eventId);
  if (card && selectEl) {
    card.dataset.eventCalendar = selectEl.options[selectEl.selectedIndex].dataset.calName;
  }
}

function addToSchedule(linkEl) {
  var card = linkEl.closest('.action-card');
  if (!card) return;
  var title = card.dataset.eventTitle;
  var startISO = card.dataset.eventStart;
  var endISO = card.dataset.eventEnd;
  var location = card.dataset.eventLocation || '';
  var select = card.querySelector('.calendar-select');
  var calName = select ? select.options[select.selectedIndex].dataset.calName : card.dataset.eventCalendar;
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (!startISO) return;
  var eventDate = new Date(startISO);
  if (eventDate.toDateString() !== tomorrow.toDateString()) return;
  var startTime = eventDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  var endTime = endISO ? new Date(endISO).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : startTime;
  var newEvent = document.createElement('div');
  newEvent.className = 'schedule-event';
  newEvent.innerHTML = '<div class="schedule-time">' + escapeText(startTime + ' – ' + endTime) + '</div>'
    + '<div class="schedule-info">'
    + '<div class="schedule-title">' + escapeText(title) + '</div>'
    + '<div class="schedule-calendar">● ' + escapeText(calName || 'Calendar') + ' (just added)</div>'
    + (location ? '<div class="schedule-location">' + escapeText(location) + '</div>' : '')
    + '</div>';
  var scheduleSection = document.getElementById('tomorrow-schedule');
  if (!scheduleSection) return;
  var noData = scheduleSection.querySelector('.no-data');
  if (noData) noData.remove();
  var existing = scheduleSection.querySelectorAll('.schedule-event');
  var inserted = false;
  for (var i = 0; i < existing.length; i++) {
    var evTime = existing[i].querySelector('.schedule-time');
    if (evTime && startTime < evTime.textContent) {
      scheduleSection.insertBefore(newEvent, existing[i]);
      inserted = true;
      break;
    }
  }
  if (!inserted) scheduleSection.appendChild(newEvent);
  newEvent.style.transition = 'background 0.5s ease';
  newEvent.style.background = 'rgba(58,117,86,.12)';
  setTimeout(function() { newEvent.style.background = ''; }, 2000);
  card.style.opacity = '0.5';
  var btns = card.querySelector('.action-buttons');
  if (btns) btns.innerHTML = '<div style="color:var(--calendar);font-size:13px;font-weight:600;">Added to calendar &amp; schedule ✓</div>';
}

function escapeText(value) {
  return String(value || '').replace(/[&<>"']/g, function(c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

function toggleTodo(el) {
  var tid = el.dataset.todoId;
  if (!tid) return;
  var checked = !el.classList.contains('checked');
  document.querySelectorAll('[data-todo-id="' + tid + '"]').forEach(function(item) {
    item.classList.toggle('checked', checked);
  });
  try {
    var stored = JSON.parse(localStorage.getItem('briefing-todos') || '{}');
    if (checked) { stored[tid] = true; } else { delete stored[tid]; }
    localStorage.setItem('briefing-todos', JSON.stringify(stored));
  } catch(e) {}
}

(function restoreTodos() {
  try {
    var stored = JSON.parse(localStorage.getItem('briefing-todos') || '{}');
    document.querySelectorAll('.todo-item[data-todo-id]').forEach(function(el) {
      if (stored[el.dataset.todoId]) el.classList.add('checked');
    });
  } catch(e) {}
})();
`;
}

// ── pure helpers ─────────────────────────────────────────────────────────────

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
  return `${formatTime(start)} – ${formatTime(end || start)}`;
}

function dateRange(start, end) {
  if (!start) return 'Date TBD';
  return `${formatDateTime(start)}${end ? ` – ${formatTime(end)}` : ''}`;
}

function formatTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || '');
  return d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || '');
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatWeekdayLabel(isoDate) {
  const d = new Date(isoDate + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric' });
}

function localISODate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${obj.year}-${obj.month}-${obj.day}`;
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
