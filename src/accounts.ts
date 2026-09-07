import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { google } from 'googleapis';

// Use googleapis' own OAuth2 client to avoid duplicate google-auth-library type copies.
export type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

export const BASE_DIR = path.join(os.homedir(), '.gmail-mcp');
export const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
export const CREDENTIALS_PATH = path.join(BASE_DIR, 'credentials.json');

export interface AccountEntry {
  email: string;
  tokenFile: string;
}

export interface Config {
  defaultAccount: string | null;
  accounts: Record<string, AccountEntry>;
}

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) return { defaultAccount: null, accounts: {} };
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(BASE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

interface ClientCredentials {
  client_id: string;
  client_secret: string;
}

export function loadClientCredentials(): ClientCredentials {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Missing OAuth client credentials at ${CREDENTIALS_PATH}. ` +
        'Download the "Desktop app" OAuth client JSON from Google Cloud Console ' +
        '(APIs & Services > Credentials) and save it there.'
    );
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const key = raw.installed ?? raw.web;
  if (!key?.client_id || !key?.client_secret) {
    throw new Error(
      `${CREDENTIALS_PATH} does not look like an OAuth client JSON ` +
        '(expected an "installed" object with client_id and client_secret).'
    );
  }
  return { client_id: key.client_id, client_secret: key.client_secret };
}

export function describeAccounts(config: Config = loadConfig()): string {
  const entries = Object.entries(config.accounts);
  if (entries.length === 0) {
    return 'No accounts configured yet — use the add_account tool or run: npm run auth -- --alias <name>';
  }
  return entries.map(([alias, a]) => `${alias} (${a.email})`).join(', ');
}

export function resolveAccount(param: string, config: Config = loadConfig()): { alias: string; entry: AccountEntry } {
  const wanted = param.trim().toLowerCase();
  const aliasHit = Object.keys(config.accounts).find((a) => a.toLowerCase() === wanted);
  if (aliasHit) return { alias: aliasHit, entry: config.accounts[aliasHit] };
  const emailHit = Object.entries(config.accounts).find(([, a]) => a.email.toLowerCase() === wanted);
  if (emailHit) return { alias: emailHit[0], entry: emailHit[1] };
  throw new Error(`Unknown account "${param}". Available: ${describeAccounts(config)}`);
}

export interface StoredToken {
  refresh_token: string;
  access_token?: string;
  expiry_date?: number;
  email: string;
}

function tokenPath(entry: AccountEntry): string {
  const normalizedTokenFile = path.normalize(entry.tokenFile.replace(/\\/g, '/'));
  if (!normalizedTokenFile || path.isAbsolute(normalizedTokenFile)) {
    throw new Error(`Invalid token path "${entry.tokenFile}" for account ${entry.email}.`);
  }
  if (normalizedTokenFile === '..' || normalizedTokenFile.startsWith(`..${path.sep}`)) {
    throw new Error(`Refusing token path outside ${BASE_DIR} for account ${entry.email}.`);
  }
  const full = path.resolve(BASE_DIR, normalizedTokenFile);
  const base = path.resolve(BASE_DIR);
  if (full !== base && !full.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Refusing token path outside ${BASE_DIR} for account ${entry.email}.`);
  }
  return full;
}

export function writeToken(entry: AccountEntry, token: StoredToken): void {
  const file = tokenPath(entry);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(token, null, 2) + '\n', { mode: 0o600 });
}

const clientCache = new Map<string, OAuth2Client>();

export function getClient(alias: string, entry: AccountEntry): OAuth2Client {
  const cached = clientCache.get(alias);
  if (cached) return cached;

  const creds = loadClientCredentials();
  const file = tokenPath(entry);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No stored authorization for account "${alias}" (${entry.email}). ` +
        `Run: npm run auth -- --alias ${alias}`
    );
  }
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredToken;

  const client = new google.auth.OAuth2({ clientId: creds.client_id, clientSecret: creds.client_secret });
  client.setCredentials({
    refresh_token: stored.refresh_token,
    access_token: stored.access_token,
    expiry_date: stored.expiry_date,
  });
  // Persist refreshed access tokens (and any rotated refresh token) so cold starts skip a refresh round-trip.
  client.on('tokens', (tokens) => {
    try {
      stored.refresh_token = tokens.refresh_token ?? stored.refresh_token;
      stored.access_token = tokens.access_token ?? stored.access_token;
      stored.expiry_date = tokens.expiry_date ?? stored.expiry_date;
      writeToken(entry, stored);
    } catch (e) {
      console.error(`gmail-multi: failed to persist refreshed token for "${alias}":`, e);
    }
  });

  clientCache.set(alias, client);
  return client;
}

export function dropClient(alias: string): void {
  clientCache.delete(alias);
}
