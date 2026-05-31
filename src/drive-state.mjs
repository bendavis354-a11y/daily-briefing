const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export function emptyState() {
  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    conversations: {},
    openTasks: [],
    ignoredConversations: {},
    snoozedConversations: {},
    people: {},
    preferences: {
      timezone: 'America/New_York',
      replyStyle: 'warm, concise, practical'
    },
    recentRuns: []
  };
}

export async function readState({ accessToken, fileId }) {
  if (!fileId) return emptyState();

  const res = await fetch(`${DRIVE}/files/${fileId}?alt=media`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });

  if (!res.ok) throw new Error(`Drive state read failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

export async function writeState({ accessToken, fileId, state }) {
  const body = JSON.stringify(state, null, 2);

  if (!fileId) {
    return createState({ accessToken, name: 'ben-assistant-state.json', state });
  }

  const res = await fetch(`${UPLOAD}/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body
  });

  if (!res.ok) throw new Error(`Drive state write failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

export async function createState({ accessToken, name, state }) {
  const boundary = `state-${Date.now()}`;
  const metadata = { name, mimeType: 'application/json' };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(state, null, 2)}\r\n` +
    `--${boundary}--`;

  const res = await fetch(`${UPLOAD}/files?uploadType=multipart`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': `multipart/related; boundary=${boundary}`
    },
    body
  });

  if (!res.ok) throw new Error(`Drive state create failed: ${res.status} ${await res.text()}`);
  const file = await res.json();
  console.log(`CREATED_STATE_FILE_ID=${file.id}`);
  return file;
}
