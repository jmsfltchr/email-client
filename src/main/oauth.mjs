// Google OAuth 2.0 for installed apps: loopback redirect + PKCE, in the system browser.

import http from 'node:http';
import crypto from 'node:crypto';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  // Sender photos (read-only): saved contacts and people you have corresponded with.
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const page = (msg) => `<!doctype html><meta charset="utf-8"><title>Stillmail</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;color:#333"><p>${msg}</p></body>`;

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || `Token request failed (${res.status})`);
    err.code = json.error;
    throw err;
  }
  return json;
}

/** Run the interactive flow. Resolves {access_token, refresh_token, expires_at}. */
export function authorize({ clientId, clientSecret }, openUrl, { timeoutMs = 5 * 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    let redirectUri = '';
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); server.close(); fn(v); };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== '/') { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (url.searchParams.get('state') !== state) { res.writeHead(400).end(page('State mismatch. Please try again from Stillmail.')); return; }
      const error = url.searchParams.get('error');
      if (error) { res.end(page('Access was not granted. You can close this tab.')); finish(reject, new Error(`Google sign-in: ${error}`)); return; }
      try {
        const tok = await tokenRequest({
          grant_type: 'authorization_code', code: url.searchParams.get('code'),
          client_id: clientId, client_secret: clientSecret || '', redirect_uri: redirectUri, code_verifier: verifier,
        });
        if (!tok.refresh_token) throw new Error('Google did not return a refresh token. Remove Stillmail from your Google account permissions and try again.');
        res.end(page('Signed in. You can close this tab and return to Stillmail.'));
        finish(resolve, { access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: Date.now() + tok.expires_in * 1000 });
      } catch (e) {
        res.end(page('Sign-in failed. Return to Stillmail for details.'));
        finish(reject, e);
      }
    });
    const timer = setTimeout(() => finish(reject, new Error('Sign-in timed out')), timeoutMs);
    server.on('error', (e) => finish(reject, e));
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`;
      const q = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
        state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent',
      });
      openUrl(`${AUTH_URL}?${q}`);
    });
  });
}

export async function refresh({ clientId, clientSecret }, refreshToken) {
  const tok = await tokenRequest({
    grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret || '',
  });
  return { access_token: tok.access_token, expires_at: Date.now() + tok.expires_in * 1000 };
}
