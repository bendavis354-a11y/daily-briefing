const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Google OAuth client ID, client secret, or refresh token.');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });

  if (!res.ok) {
    throw new Error(`OAuth refresh failed: ${res.status} ${await res.text()}`);
  }

  return (await res.json()).access_token;
}
