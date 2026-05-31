import fs from 'node:fs';
import crypto from 'node:crypto';

const password = process.env.BRIEFING_PASSWORD;
if (!password) {
  console.error('BRIEFING_PASSWORD is not set.');
  process.exit(1);
}

const inputPath = process.env.PLAIN_BRIEFING_HTML || 'dist/briefing.plain.html';
const outputPath = process.env.ENCRYPTED_BRIEFING_HTML || 'index.html';
const plaintext = fs.readFileSync(inputPath, 'utf8');
const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const iterations = Number(process.env.BRIEFING_PBKDF2_ITERATIONS || 250000);
const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
const authTag = cipher.getAuthTag();
const blob = Buffer.concat([salt, iv, encrypted, authTag]).toString('base64');

const shell = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Inbox Briefing</title>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root { --bg: #FAFAF5; --surface: #FFFFFF; --border: #E5E2D6; --text: #1C1B19; --text-muted: #8A8780; --accent: #A8843A; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: var(--bg); color: var(--text); font-family: 'Inter', -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .gate { text-align: center; max-width: 380px; padding: 40px 24px; }
    .gate-icon { width: 56px; height: 56px; border-radius: 14px; background: linear-gradient(135deg, var(--accent), #8B6E2E); display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 24px; margin: 0 auto 20px; font-family: 'Instrument Serif', Georgia, serif; }
    .gate h1 { font-family: 'Instrument Serif', Georgia, serif; font-size: 28px; font-weight: 400; margin-bottom: 6px; }
    .gate p { color: var(--text-muted); font-size: 13px; margin-bottom: 24px; }
    .gate input { width: 100%; padding: 12px 16px; border: 1px solid var(--border); border-radius: 10px; font-family: inherit; font-size: 15px; background: var(--surface); outline: none; text-align: center; letter-spacing: 2px; transition: border-color 0.2s; }
    .gate input:focus { border-color: var(--accent); }
    .gate button { width: 100%; margin-top: 12px; padding: 12px; background: var(--text); color: var(--bg); border: none; border-radius: 10px; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    .gate button:hover { background: #000; }
    .gate-error { color: #B83A3A; font-size: 12px; margin-top: 10px; min-height: 18px; }
  </style>
</head>
<body>
  <div class="gate" id="gate">
    <div class="gate-icon">B</div>
    <h1>Inbox Briefing</h1>
    <p>Enter your password to view today's briefing.</p>
    <input type="password" id="pw" placeholder="••••••••" autofocus onkeydown="if(event.key==='Enter')decrypt()">
    <button onclick="decrypt()">Unlock</button>
    <div class="gate-error" id="err"></div>
  </div>
  <script>
    const BLOB = "${blob}";
    const ITERATIONS = ${iterations};
    function b64ToBytes(b64) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    async function decrypt() {
      const pw = document.getElementById('pw').value;
      if (!pw) return;
      try {
        const raw = b64ToBytes(BLOB);
        const salt = raw.slice(0, 16);
        const iv = raw.slice(16, 28);
        const encryptedAndTag = raw.slice(28);
        const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
        const key = await crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
          keyMaterial,
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt']
        );
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encryptedAndTag);
        const html = new TextDecoder().decode(decrypted);
        document.open();
        document.write(html);
        document.close();
      } catch (e) {
        document.getElementById('err').textContent = 'Incorrect password. Try again.';
        document.getElementById('pw').value = '';
        document.getElementById('pw').focus();
      }
    }
  </script>
</body>
</html>`;

fs.writeFileSync(outputPath, shell);
console.log(`Wrote encrypted ${outputPath}`);
