import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { CodeChallengeMethod } from 'google-auth-library';
import { google } from 'googleapis';
import { loadClientCredentials, loadConfig, saveConfig, writeToken, dropClient } from './accounts.js';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

export interface AuthResult {
  alias: string;
  email: string;
}

/**
 * Loopback OAuth flow (RFC 8252): ephemeral localhost server captures the redirect,
 * exchanges the code, discovers the real email via getProfile, and persists the token
 * under the alias. Shared by the auth CLI and the add_account MCP tool.
 */
export async function authorizeAccount(
  alias: string,
  expectedEmail?: string,
  log: (msg: string) => void = (m) => console.error(m)
): Promise<AuthResult> {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(alias)) {
    throw new Error(`Alias "${alias}" must be alphanumeric (dashes/underscores allowed).`);
  }
  const creds = loadClientCredentials();

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const client = new google.auth.OAuth2({
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
    redirectUri,
  });
  const oauthState = randomUUID();
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force a refresh token even on re-auth
    scope: [GMAIL_SCOPE],
    login_hint: expectedEmail,
    state: oauthState,
    code_challenge_method: 'S256' as CodeChallengeMethod,
    code_challenge: codeChallenge,
  });

  const codePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out after 5 minutes waiting for browser authorization. Re-run the auth.'));
    }, AUTH_TIMEOUT_MS);
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const stateOk = state === oauthState;
      res.end(
        '<html><body style="font-family:sans-serif;margin:40px"><h2>gmail-mcp</h2><p>' +
          (code && stateOk
            ? 'Authorized. You can close this tab.'
            : `Authorization failed: ${
                !stateOk ? 'invalid OAuth state; re-run auth from your terminal' : error ?? 'unknown error'
              }`) +
          '</p></body></html>'
      );
      clearTimeout(timer);
      if (!stateOk) reject(new Error('OAuth callback state mismatch. Re-run the auth command and try again.'));
      else if (code) resolve(code);
      else reject(new Error(`Authorization failed: ${error ?? 'no code returned'}`));
    });
  });

  log(`Authorize ${expectedEmail ?? `account "${alias}"`} in the browser (URL below if it didn't open):\n${authUrl}`);
  try {
    spawn('open', [authUrl], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // browser open is best-effort; the URL was printed
  }

  try {
    const code = await codePromise;
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.refresh_token) {
      throw new Error(
        'Google did not return a refresh token. Re-run the auth; if it persists, remove this app at ' +
          'myaccount.google.com/permissions and try again.'
      );
    }
    client.setCredentials(tokens);

    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress ?? '';
    if (!email) throw new Error('Could not determine the authorized email address from the Gmail profile.');
    if (expectedEmail && email.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new Error(
        `Authorized ${email}, but expected ${expectedEmail}. This usually means the wrong Google session ` +
          'was active in the browser — re-run and pick the right account on the consent screen.'
      );
    }

    const config = loadConfig();
    const dupe = Object.entries(config.accounts).find(
      ([a, e]) => a !== alias && e.email.toLowerCase() === email.toLowerCase()
    );
    if (dupe) throw new Error(`${email} is already connected as alias "${dupe[0]}".`);

    const entry = { email, tokenFile: `tokens/${alias}.json` };
    writeToken(entry, {
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token ?? undefined,
      expiry_date: tokens.expiry_date ?? undefined,
      email,
    });
    config.accounts[alias] = entry;
    saveConfig(config);
    dropClient(alias); // any cached client for this alias is stale now

    return { alias, email };
  } finally {
    server.close();
  }
}
