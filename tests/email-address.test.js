'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(join(__dirname, '..', 'dashboard', 'lib', 'email-address.ts')).href;

test('keeps a bare sender address unchanged', async () => {
  const { normalizeEmailAddress } = await import(MODULE);
  assert.equal(normalizeEmailAddress('careers@example.com'), 'careers@example.com');
});

test('strips a display name from an address before sending through Zoho', async () => {
  const { normalizeEmailAddress } = await import(MODULE);
  assert.equal(normalizeEmailAddress('3Space Careers <careers@a3spacetech.com>'), 'careers@a3spacetech.com');
});

test('rejects a sender value that is not an email address', async () => {
  const { normalizeEmailAddress } = await import(MODULE);
  assert.equal(normalizeEmailAddress('3Space Careers'), null);
});
