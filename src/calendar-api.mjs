import { getAccessToken } from './google-auth.mjs';

const CALENDAR = 'https://www.googleapis.com/calendar/v3';

export async function listTomorrowEventsForAccount({ account, clientId, clientSecret, timeMinISO, timeMaxISO }) {
  const refreshToken = process.env[account.refreshTokenEnv];
  const accessToken = await getAccessToken({ clientId, clientSecret, refreshToken });
  const calendars = await listCalendars({ accessToken });
  const events = [];

  for (const calendar of calendars) {
    const calendarEvents = await listEvents({
      accessToken,
      calendarId: calendar.id,
      timeMinISO,
      timeMaxISO
    });

    for (const event of calendarEvents) {
      events.push({
        account: account.email,
        calendarName: calendar.summary || calendar.id,
        calendarId: calendar.id,
        color: calendar.backgroundColor || '',
        title: event.summary || '(no title)',
        start: event.start?.dateTime || event.start?.date || null,
        end: event.end?.dateTime || event.end?.date || null,
        allDay: Boolean(event.start?.date),
        location: event.location || '',
        htmlLink: event.htmlLink || '',
        attendees: (event.attendees || []).map(a => a.email).filter(Boolean)
      });
    }
  }

  events.sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
  return { calendars, events };
}

export async function listCalendars({ accessToken }) {
  const res = await fetch(`${CALENDAR}/users/me/calendarList`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });

  if (!res.ok) throw new Error(`Calendar list failed: ${res.status} ${await res.text()}`);
  return (await res.json()).items || [];
}

export async function listEvents({ accessToken, calendarId, timeMinISO, timeMaxISO }) {
  const url = new URL(`${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('timeMin', timeMinISO);
  url.searchParams.set('timeMax', timeMaxISO);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('timeZone', 'America/New_York');

  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Calendar events failed: ${res.status} ${await res.text()}`);
  return (await res.json()).items || [];
}
