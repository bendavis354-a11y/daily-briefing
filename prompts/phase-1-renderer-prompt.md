# Phase 1 Routine Prompt Addendum

Use this after the routine gathers Gmail and Calendar data.

```text
Instead of writing index.html directly, write briefing.json at the repo root.

The JSON must match schemas/briefing.schema.json and should include these fields wherever possible:

- metadata.generatedAt
- metadata.date
- metadata.timezone
- metadata.lastSuccessfulBuildAt
- metadata.dataFreshThrough
- metadata.liveUrl
- stats.emailsScanned
- stats.urgent
- stats.eventsTomorrow
- stats.proposedEvents
- stats.suggestedReplies
- stats.todos
- accounts: [{ email, label, type }]
- calendars: [{ id, name, color }]

For email-derived items, include:
- account or sourceAccount
- sender
- senderName if known
- senderEmail if known
- subject
- summary
- gmailThreadId
- threadId if different
- conversationKey if known

For suggestedReplies, include:
- title
- detail
- senderEmail or to
- subject or replySubject
- body
- gmailThreadId

For calendarProposals, include:
- id
- title
- start
- end
- location
- detail
- context
- sourceSender
- sourceSubject
- calendarId

For tomorrowSchedule, include:
- title
- start
- end
- allDay
- location
- calendarName
- calendarId
- htmlLink
- color if known

For todos, include:
- account
- priority: high, medium, or low
- text

Then run:

npm install
npm run build

If validation or build fails, stop and report the error. Do not deploy a broken page.

If the build succeeds:

git checkout -B claude/briefing
git add index.html .nojekyll
git commit -m "Briefing $(date +%Y-%m-%d)" || true
git push origin claude/briefing --force-with-lease
```

