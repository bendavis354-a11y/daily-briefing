/**
 * Render the daily briefing as a narrative "chief of staff" page.
 *
 * Reads briefing.json (facts gathered by scripts + `narrative` written by the
 * agent's synthesis step), validates against schemas/briefing.schema.json, and
 * writes dist/briefing.plain.html for encrypt-page.mjs.
 *
 * Design intent: this is a briefing, not an inbox mirror. The story leads;
 * storylines carry memory (so far → today → heading → needs); decisions arrive
 * teed up with one-click actions; raw categorized mail survives only as a
 * collapsed appendix. If the narrative is missing (synthesis failed), a plain
 * fallback keeps the page useful.
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
const narrative = briefing.narrative || null;
const TZ = meta.timezone || 'America/New_York';
const todayISO = localISODate(new Date(), TZ);
const isStale = meta.date !== todayISO;

// ── account identity ─────────────────────────────────────────────────────────
// Ben's three hats: Biodynamic Association board, Heartspring Gardens startup,
// personal life. Each gets a stable hue so a glance places every item.
const ACCOUNT_META = {};
for (const a of briefing.accounts || []) {
  const email = (a.email || '').toLowerCase();
  let cls = 'acct-other';
  if (email.includes('biodynamics')) cls = 'acct-bda';
  else if (email.includes('heartspring')) cls = 'acct-hs';
  else if (email) cls = 'acct-personal';
  ACCOUNT_META[email] = { label: a.label || a.email, cls };
}
function acct(email) {
  const key = String(email || '').toLowerCase();
  return ACCOUNT_META[key] || { label: shortAcct(email), cls: 'acct-other' };
}
function shortAcct(email) {
  const e = String(email || '');
  if (e.includes('biodynamics')) return 'Biodynamics';
  if (e.includes('heartspring')) return 'Heartspring';
  if (e.includes('gmail')) return 'Personal';
  return e || '—';
}
function acctChip(email) {
  if (!email) return '';
  const { label, cls } = acct(email);
  return `<span class="chip ${cls}">${esc(label)}</span>`;
}

// ── trend vocabulary ─────────────────────────────────────────────────────────
const TREND = {
  rising: { glyph: '↗', label: 'gaining momentum', cls: 'trend-rising' },
  steady: { glyph: '→', label: 'steady', cls: 'trend-steady' },
  waiting: { glyph: '◷', label: 'waiting on them', cls: 'trend-waiting' },
  stalling: { glyph: '↘', label: 'stalling — needs a nudge', cls: 'trend-stalling' },
  closing: { glyph: '✓', label: 'wrapping up', cls: 'trend-closing' },
  new: { glyph: '✦', label: 'new this week', cls: 'trend-new' }
};
function trendChip(t) {
  const tr = TREND[t] || TREND.steady;
  return `<span class="trend ${tr.cls}" title="${esc(tr.label)}">${tr.glyph} ${esc(tr.label)}</span>`;
}

// ── links (all actions are plain <a target="_blank">; nothing auto-sends) ────
function threadLink(account, threadId) {
  if (!threadId) return '';
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account || '')}#all/${encodeURIComponent(threadId)}`;
}
function composeLink({ account, to, subject, body }) {
  const p = new URLSearchParams({ view: 'cm', fs: '1' });
  if (account) p.set('authuser', account);
  if (to) p.set('to', to);
  if (subject) p.set('su', subject);
  if (body) p.set('body', body);
  return `https://mail.google.com/mail/?${p.toString()}`;
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

// ── narrative components ─────────────────────────────────────────────────────
function hero() {
  const n = narrative || fallbackNarrative();
  const dateLine = meta.todayLabel || meta.date;
  return `
  <section class="hero">
    <div class="kicker">Chief of staff briefing · ${esc(dateLine)}</div>
    <h1>${esc(n.headline)}</h1>
    <div class="story">${n.story.split(/\n\n+/).map(p => `<p>${esc(p)}</p>`).join('')}</div>
  </section>`;
}

function accountLegend() {
  const chips = (briefing.accounts || []).map(a => {
    const { label, cls } = acct(a.email);
    return `<button class="chip ${cls} filter-chip" data-account="${escAttr((a.email || '').toLowerCase())}" onclick="filterAccount(this)">${esc(label)}</button>`;
  }).join('');
  return `<div class="legend" role="group" aria-label="Filter by account">
    <button class="chip acct-all filter-chip active" data-account="all" onclick="filterAccount(this)">All</button>${chips}
  </div>`;
}

function storylines() {
  const n = narrative || fallbackNarrative();
  const arcs = [...(n.arcs || [])].sort((a, b) => (b.importance || 3) - (a.importance || 3));
  if (!arcs.length) return '';
  return `
  <section class="block">
    <h2 class="block-title">The storylines</h2>
    ${arcs.map(arcCard).join('')}
  </section>`;
}

function arcCard(arc) {
  const email = (arc.account || '').toLowerCase();
  const beats = [
    arc.soFar ? beat('The story so far', arc.soFar) : '',
    beat('Today', arc.today),
    arc.heading ? beat('Where it’s heading', arc.heading) : ''
  ].join('');
  const needs = arc.needs
    ? `<div class="needs"><span class="needs-label">Needs from you</span>${esc(arc.needs)}</div>`
    : '';
  const openHref = threadLink(arc.viewThreadAccount || arc.account, arc.viewThreadId);
  const autoOpen = openHref && !(arc.actions || []).some(a => a.type === 'open')
    ? extA(openHref, 'btn btn-quiet', 'Open thread')
    : '';
  return `
  <article class="arc" data-account="${escAttr(email)}">
    <header class="arc-head">
      <div class="arc-chips">${acctChip(arc.account)}${trendChip(arc.trend)}</div>
      <h3 class="arc-title">${esc(arc.title)}</h3>
      ${arc.stakes ? `<div class="stakes">${esc(arc.stakes)}</div>` : ''}
    </header>
    <div class="arc-body">${beats}</div>
    ${needs}
    <div class="actions">${(arc.actions || []).map(a => actionButton(a, arc)).join('')}${autoOpen}</div>
  </article>`;
}

function beat(label, text) {
  return `<div class="beat"><span class="beat-label">${label}</span><span class="beat-text">${esc(text)}</span></div>`;
}

function actionButton(a, arc) {
  const account = a.account || arc?.viewThreadAccount || arc?.account || '';
  if (a.type === 'reply') {
    return extA(composeLink({ account, to: a.to, subject: a.subject, body: a.body }), 'btn btn-primary', esc(a.label));
  }
  if (a.type === 'calendar') {
    return extA(calendarTemplateLink(a), 'btn btn-cal', esc(a.label));
  }
  if (a.type === 'open') {
    const href = threadLink(account, a.threadId || arc?.viewThreadId);
    return href ? extA(href, 'btn btn-quiet', esc(a.label)) : '';
  }
  return '';
}

function decisions() {
  const list = narrative?.decisions || [];
  if (!list.length) return '';
  return `
  <section class="block">
    <h2 class="block-title">Decisions, teed up</h2>
    <ol class="decision-list">
      ${list.map(d => `
      <li class="decision" ${d.arcId ? `data-arc="${escAttr(d.arcId)}"` : ''}>
        <div class="decision-q">${esc(d.question)}</div>
        ${d.context ? `<div class="decision-ctx">${esc(d.context)}</div>` : ''}
        ${d.leaning ? `<div class="decision-lean">My read: ${esc(d.leaning)}</div>` : ''}
        <div class="actions">${(d.options || []).map(o => decisionOption(o)).join('')}</div>
      </li>`).join('')}
    </ol>
  </section>`;
}

function decisionOption(o) {
  if (o?.action?.type) return actionButton(o.action, null) || `<span class="option">${esc(o.label || '')}</span>`;
  return o?.label ? `<span class="option">${esc(o.label)}${o.detail ? ` — ${esc(o.detail)}` : ''}</span>` : '';
}

// ── schedule ─────────────────────────────────────────────────────────────────
function schedule() {
  const tomorrow = sections.tomorrowSchedule || [];
  const week = sections.weekSchedule || [];
  const proposals = sections.calendarProposals || [];
  if (!tomorrow.length && !week.length && !proposals.length) return '';
  return `
  <section class="block">
    <h2 class="block-title">${esc(meta.tomorrowLabel || 'Tomorrow')}</h2>
    <div id="tomorrow-schedule" class="timeline">
      ${tomorrow.length ? tomorrow.map(eventRow).join('') : '<div class="empty">Nothing on the calendar tomorrow — a clear runway.</div>'}
    </div>
    ${proposals.length ? `
    <h3 class="sub-title">Wants a spot on the calendar</h3>
    ${proposals.map(proposalCard).join('')}` : ''}
    ${week.length > tomorrow.length ? `
    <details class="week"><summary>Rest of the week (${week.length} events)</summary>
      <div class="timeline">${week.map(eventRow).join('')}</div>
    </details>` : ''}
  </section>`;
}

function eventRow(ev) {
  const t = ev.allDay ? 'All day' : fmtTime(ev.start);
  return `<div class="event">
    <span class="event-time">${esc(t)}</span>
    <span class="event-dot" style="--dot:${escAttr(ev.color || '#3A7556')}"></span>
    <span class="event-body"><strong>${esc(ev.title)}</strong>${ev.location ? ` · ${esc(ev.location)}` : ''}<span class="event-cal">${esc(ev.calendarName || '')}</span></span>
    ${ev.htmlLink ? extA(ev.htmlLink, 'btn btn-mini', 'Open') : ''}
  </div>`;
}

function proposalCard(p, i) {
  const id = `prop-${i}`;
  const start = p.start || defaultStart();
  const end = p.end || '';
  const href = calendarTemplateLink({ title: p.title, start, end, details: p.context || p.detail, location: p.location });
  return `<div class="proposal" data-account="${escAttr((p.account || '').toLowerCase())}">
    <div class="proposal-head">${acctChip(p.account)}<strong>${esc(p.title)}</strong></div>
    ${p.context ? `<div class="proposal-ctx">${esc(p.context)}</div>` : ''}
    <div class="proposal-controls">
      <input type="datetime-local" id="${id}-start" value="${escAttr(toLocalInput(start))}" onchange="updateCalLink('${id}')">
      <a id="${id}-link" class="btn btn-cal" href="${escAttr(href)}" target="_blank" rel="noopener"
         data-title="${escAttr(p.title || '')}" data-details="${escAttr(p.context || p.detail || '')}" data-location="${escAttr(p.location || '')}"
         onclick="addToSchedule('${id}')">Add to calendar</a>
    </div>
  </div>`;
}

// ── quick hits + noise ───────────────────────────────────────────────────────
function quickHits() {
  const list = narrative?.quickHits || [];
  if (!list.length) return '';
  return `
  <section class="block">
    <h2 class="block-title">Quick hits</h2>
    <ul class="hits">
      ${list.map(q => {
        const href = q.viewThreadId ? threadLink(q.viewThreadAccount || q.account, q.viewThreadId) : '';
        return `<li data-account="${escAttr((q.account || '').toLowerCase())}">${acctChip(q.account)} ${esc(q.text)}${href ? ` ${extA(href, 'hit-link', 'view')}` : ''}</li>`;
      }).join('')}
    </ul>
  </section>`;
}

function noiseLine() {
  const n = narrative?.noise;
  const count = n?.count ?? ((sections.newsletter?.length || 0) + (sections.spam?.length || 0));
  if (!count && !n?.note) return '';
  const note = n?.note || 'newsletters, promotions, and receipts — nothing that needs you.';
  return `<div class="noise">Compressed ${count} lower-signal messages: ${esc(note)}</div>`;
}

// ── appendix: the raw inbox, demoted to a collapsed reference ────────────────
function appendix() {
  const groups = [
    ['Urgent', sections.urgent], ['Business', sections.business], ['Personal', sections.personal],
    ['Financial', sections.financial], ['Waiting on others', sections.waiting],
    ['Newsletters', sections.newsletter], ['Spam', sections.spam]
  ].filter(([, list]) => list?.length);
  const imsgs = (sections.imessage || []).filter(m => !String(m.id).includes('notice'));
  if (!groups.length && !imsgs.length) return '';
  return `
  <section class="block appendix">
    <details><summary>Everything else — the full sorted inbox (${groups.reduce((n, [, l]) => n + l.length, 0)} threads${imsgs.length ? `, ${imsgs.length} text conversations` : ''})</summary>
      ${imsgs.length ? `<h3 class="sub-title">Texts</h3><ul class="raw-list">${imsgs.map(m =>
        `<li><strong>${esc(m.sender)}</strong> — ${esc(m.summary)}${m.needsReply ? ' <span class="tag-reply">reply</span>' : ''}</li>`).join('')}</ul>` : ''}
      ${groups.map(([name, list]) => `
      <h3 class="sub-title">${name} (${list.length})</h3>
      <ul class="raw-list">
        ${list.map(it => {
          const href = it.viewThreadId || it.gmailThreadId ? threadLink(it.viewThreadAccount || it.account, it.viewThreadId || it.gmailThreadId) : '';
          return `<li data-account="${escAttr((it.account || '').toLowerCase())}">${acctChip(it.account)} <strong>${esc(it.senderName || it.sender || '')}</strong> — ${esc(it.subject || '')}${href ? ` ${extA(href, 'hit-link', 'open')}` : ''}</li>`;
        }).join('')}
      </ul>`).join('')}
    </details>
  </section>`;
}

function footer() {
  const s = briefing.stats || {};
  const tracked = narrative?.arcs?.length || 0;
  return `
  <footer>
    <div>Scanned ${s.emailsScanned ?? 0} messages across ${(briefing.accounts || []).length} accounts · following ${tracked} storylines in memory · generated ${esc(fmtTime(meta.generatedAt))}</div>
    <div>No emails are ever sent automatically. Every button opens Gmail or Calendar for you to review and send.</div>
  </footer>`;
}

function staleWarning() {
  return `<div class="stale">This briefing is from ${esc(meta.date)} — a newer run hasn't landed yet. Treat details as possibly out of date.</div>`;
}

// ── fallback when synthesis didn't run ───────────────────────────────────────
function fallbackNarrative() {
  const urgent = sections.urgent || [];
  const replies = sections.suggestedReplies || [];
  const waiting = sections.waiting || [];
  const arcs = [...urgent.map(u => ({
    id: `fb-${u.conversationKey || u.subject}`, title: u.subject || 'Urgent thread',
    account: u.account, trend: 'rising', importance: 5,
    stakes: 'Flagged urgent by the scanner.', today: u.summary || u.snippet || '',
    needs: 'Review and respond.', viewThreadAccount: u.viewThreadAccount || u.account, viewThreadId: u.viewThreadId || u.gmailThreadId,
    actions: []
  })), ...replies.slice(0, 4).map(r => ({
    id: `fb-r-${r.conversationKey || r.subject}`, title: r.title || `Reply to ${r.senderName || r.senderEmail}`,
    account: r.account, trend: 'waiting', importance: 4,
    stakes: '', today: r.detail || '', needs: 'A reply from you.',
    viewThreadAccount: r.viewThreadAccount || r.account, viewThreadId: r.viewThreadId || r.gmailThreadId,
    actions: [{ type: 'reply', label: 'Draft reply', account: r.account, to: r.to || r.senderEmail, subject: r.subject ? `Re: ${r.subject.replace(/^re:\s*/i, '')}` : '', body: r.body || '' }]
  }))].slice(0, 6);
  return {
    headline: 'Today’s briefing (narrative unavailable — showing the essentials)',
    story: 'The synthesis step didn’t run this time, so this is the scanner’s straight read: the items below are what most plausibly need you, with drafts where possible. Full sorted mail is in the appendix.',
    arcs,
    quickHits: waiting.slice(0, 6).map(w => ({ text: `Waiting on ${w.senderName || w.sender}: ${w.subject}`, account: w.account, viewThreadAccount: w.viewThreadAccount, viewThreadId: w.viewThreadId })),
    noise: null,
    decisions: []
  };
}

// ── page ─────────────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Briefing — ${esc(meta.date)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${css()}</style>
</head>
<body>
  <main>
    ${isStale ? staleWarning() : ''}
    ${hero()}
    ${accountLegend()}
    ${storylines()}
    ${decisions()}
    ${schedule()}
    ${quickHits()}
    ${noiseLine()}
    ${appendix()}
  </main>
  ${footer()}
  <script>${clientJs()}</script>
</body>
</html>`;

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync(outPath, html);
console.log(`Rendered ${outPath}${narrative ? '' : ' (fallback mode — no narrative present)'}`);

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

// ── styles ───────────────────────────────────────────────────────────────────
function css() {
  return `
:root {
  --paper:#FAF7F1; --card:#FFFFFF; --ink:#22301F; --muted:#6B7466; --line:#E5E0D4;
  --hs:#3A7556; --hs-soft:#E7F0EA; --bda:#A8843A; --bda-soft:#F5EEDD;
  --pers:#3D5DAA; --pers-soft:#E8EDF8; --urgent:#B4543A; --urgent-soft:#F8E9E3;
}
* { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--paper); color:var(--ink); font-family:Inter,system-ui,sans-serif; font-size:15px; line-height:1.55; }
main { max-width:760px; margin:0 auto; padding:28px 20px 40px; }
a { color:var(--hs); }

.kicker { font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin-bottom:10px; }
.hero h1 { font-family:'Instrument Serif',Georgia,serif; font-size:clamp(28px,5vw,40px); line-height:1.15; font-weight:400; margin-bottom:14px; }
.story p { font-family:'Instrument Serif',Georgia,serif; font-size:19px; line-height:1.5; color:#33402F; margin-bottom:10px; }
.stale { background:var(--urgent-soft); color:var(--urgent); border:1px solid #E4C0B2; border-radius:10px; padding:10px 14px; margin-bottom:18px; font-weight:500; }

.legend { display:flex; flex-wrap:wrap; gap:8px; margin:22px 0 6px; }
.chip { display:inline-block; font-size:11.5px; font-weight:600; letter-spacing:.02em; padding:3px 10px; border-radius:999px; border:1px solid transparent; }
.acct-hs { background:var(--hs-soft); color:var(--hs); }
.acct-bda { background:var(--bda-soft); color:#7A5E22; }
.acct-personal { background:var(--pers-soft); color:var(--pers); }
.acct-other,.acct-all { background:#EEECE4; color:var(--muted); }
button.filter-chip { cursor:pointer; font-family:inherit; font-size:12px; }
button.filter-chip.active { outline:2px solid var(--ink); outline-offset:1px; }

.block { margin-top:34px; }
.block-title { font-family:'Instrument Serif',Georgia,serif; font-size:24px; font-weight:400; border-bottom:1px solid var(--line); padding-bottom:6px; margin-bottom:16px; }
.sub-title { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:18px 0 8px; }

.arc { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 20px; margin-bottom:14px; box-shadow:0 1px 2px rgba(34,48,31,.04); }
.arc-chips { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
.arc-title { font-family:'Instrument Serif',Georgia,serif; font-size:21px; font-weight:400; }
.stakes { font-style:italic; color:var(--muted); font-size:13.5px; margin-top:2px; }
.trend { font-size:11.5px; font-weight:600; padding:3px 9px; border-radius:999px; }
.trend-rising { background:var(--hs-soft); color:var(--hs); }
.trend-steady { background:#EEECE4; color:var(--muted); }
.trend-waiting { background:var(--pers-soft); color:var(--pers); }
.trend-stalling { background:var(--urgent-soft); color:var(--urgent); }
.trend-closing { background:#E9F1E4; color:#4C7A3D; }
.trend-new { background:var(--bda-soft); color:#7A5E22; }

.arc-body { margin-top:12px; display:grid; gap:8px; }
.beat { display:grid; grid-template-columns:118px 1fr; gap:10px; }
.beat-label { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); padding-top:2px; }
.beat-text { font-size:14.5px; }
@media (max-width:560px){ .beat{ grid-template-columns:1fr; gap:2px; } }

.needs { margin-top:12px; background:#FBF4E6; border-left:3px solid var(--bda); border-radius:0 10px 10px 0; padding:10px 14px; font-size:14.5px; }
.needs-label { display:block; font-size:10.5px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#7A5E22; margin-bottom:2px; }

.actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
.btn { display:inline-block; font-size:13px; font-weight:600; padding:7px 14px; border-radius:9px; text-decoration:none; border:1px solid var(--line); }
.btn-primary { background:var(--hs); border-color:var(--hs); color:#fff; }
.btn-cal { background:var(--pers-soft); border-color:#C9D4EC; color:var(--pers); }
.btn-quiet { background:transparent; color:var(--ink); }
.btn-mini { font-size:11.5px; padding:3px 9px; background:transparent; color:var(--muted); }
.option { font-size:13px; padding:7px 12px; border:1px dashed var(--line); border-radius:9px; color:var(--muted); }

.decision-list { list-style:none; counter-reset:d; }
.decision { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px 18px 16px 52px; margin-bottom:12px; position:relative; counter-increment:d; }
.decision::before { content:counter(d); position:absolute; left:16px; top:16px; width:24px; height:24px; border-radius:50%; background:var(--ink); color:var(--paper); font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; }
.decision-q { font-weight:600; font-size:15.5px; }
.decision-ctx { color:var(--muted); font-size:13.5px; margin-top:4px; }
.decision-lean { font-style:italic; font-size:13.5px; margin-top:6px; color:#33402F; }

.timeline { display:grid; gap:6px; }
.event { display:flex; align-items:baseline; gap:10px; padding:8px 10px; background:var(--card); border:1px solid var(--line); border-radius:10px; }
.event-time { font-variant-numeric:tabular-nums; font-weight:600; font-size:13px; min-width:64px; color:var(--muted); }
.event-dot { width:9px; height:9px; border-radius:50%; background:var(--dot,#3A7556); flex:none; align-self:center; }
.event-body { flex:1; font-size:14px; }
.event-cal { display:block; font-size:11.5px; color:var(--muted); }
.empty { color:var(--muted); font-style:italic; padding:6px 2px; }
.week summary { cursor:pointer; color:var(--muted); font-size:13.5px; margin:10px 0; }

.proposal { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:10px; }
.proposal-head { display:flex; gap:8px; align-items:center; }
.proposal-ctx { color:var(--muted); font-size:13.5px; margin-top:4px; }
.proposal-controls { display:flex; flex-wrap:wrap; gap:10px; margin-top:10px; align-items:center; }
.proposal-controls input { font-family:inherit; font-size:13px; padding:6px 8px; border:1px solid var(--line); border-radius:8px; background:var(--paper); color:var(--ink); }
.proposal.added { border-color:var(--hs); background:var(--hs-soft); }

.hits { list-style:none; display:grid; gap:8px; }
.hits li { padding:8px 12px; background:var(--card); border:1px solid var(--line); border-radius:10px; font-size:14px; }
.hit-link { font-size:12px; color:var(--pers); }

.noise { margin-top:26px; color:var(--muted); font-size:13.5px; font-style:italic; border-top:1px dashed var(--line); padding-top:14px; }

.appendix summary { cursor:pointer; font-size:14px; color:var(--muted); padding:10px 0; }
.raw-list { list-style:none; display:grid; gap:6px; margin-bottom:6px; }
.raw-list li { font-size:13.5px; padding:6px 10px; background:var(--card); border:1px solid var(--line); border-radius:8px; }
.tag-reply { font-size:10.5px; font-weight:700; color:var(--urgent); text-transform:uppercase; }

footer { max-width:760px; margin:0 auto; padding:18px 20px 40px; color:var(--muted); font-size:12.5px; border-top:1px solid var(--line); display:grid; gap:4px; }
[data-account].hidden-by-filter { display:none; }
`;
}

// ── client JS ────────────────────────────────────────────────────────────────
function clientJs() {
  return `
function filterAccount(btn) {
  var target = btn.getAttribute('data-account');
  document.querySelectorAll('.filter-chip').forEach(function (b) { b.classList.toggle('active', b === btn); });
  document.querySelectorAll('[data-account]').forEach(function (el) {
    if (el.classList.contains('filter-chip')) return;
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
  var card = document.getElementById(id + '-link');
  if (card) { var box = card.closest('.proposal'); if (box) box.classList.add('added'); }
  return true; // let the <a target="_blank"> proceed to Google Calendar
}
`;
}
