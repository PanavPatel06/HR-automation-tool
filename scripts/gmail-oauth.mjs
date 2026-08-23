#!/usr/bin/env node
/**
 * One-time setup: turns a Google Cloud OAuth client into the three values the
 * dashboard needs to talk to Gmail directly (GMAIL_CLIENT_ID,
 * GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN — see dashboard/lib/gmail.ts and
 * dashboard/README.md#gmail-real-import--send).
 *
 * The dashboard has no OAuth UI of its own, so this script is a one-time,
 * local, human-in-the-browser stand-in for one.
 *
 * Before running this, in https://console.cloud.google.com for the SAME
 * project used for Sheets:
 *   1. APIs & Services → Library → enable the "Gmail API".
 *   2. APIs & Services → Credentials → Create Credentials → OAuth client ID
 *      → Application type "Desktop app". Note the Client ID and Client Secret.
 *   3. OAuth consent screen: add the Gmail address you're granting access to
 *      as a Test user (unless the app is published/verified).
 *
 * Usage:
 *   node scripts/gmail-oauth.mjs <client-id> <client-secret>
 *
 * It opens a local server, prints a Google consent URL to open by hand,
 * captures the redirect, exchanges the code for tokens, and prints the
 * refresh token. Nothing is written to disk — paste it into
 * dashboard/.env.local yourself.
 */

import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { google } = require('googleapis');

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error('\nUsage: node scripts/gmail-oauth.mjs <client-id> <client-secret>\n');
  console.error('Get these from Google Cloud Console → APIs & Services → Credentials\n(OAuth client ID, application type "Desktop app"). See the comment at the\ntop of this file for the full one-time setup.\n');
  process.exit(1);
}

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/oauth2callback') { res.writeHead(404); res.end(); return; }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Google returned an error: ${error}. Close this tab and check the terminal.`);
    console.error(`\n✖ Google returned an error: ${error}\n`);
    server.close();
    process.exit(1);
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Done — you can close this tab and go back to the terminal.');

  const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  try {
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      console.error('\n✖ Google did not return a refresh token.');
      console.error('  This usually means this Google account already granted access before.');
      console.error('  Fix: revoke it at https://myaccount.google.com/permissions, then run this script again.\n');
      process.exit(1);
    }
    console.log('\n✓ Got it. Add these to dashboard/.env.local:\n');
    console.log(`GMAIL_CLIENT_ID=${clientId}`);
    console.log(`GMAIL_CLIENT_SECRET=${clientSecret}`);
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  } catch (err) {
    console.error(`\n✖ Failed to exchange the code for tokens: ${err.message}\n`);
    process.exit(1);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const authUrl = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

  console.log('\nOpen this URL, sign in with the Gmail account the dashboard should use,');
  console.log('and approve access. Waiting for the redirect back to this script…\n');
  console.log(authUrl + '\n');
});
