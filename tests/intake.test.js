'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidEmail, normalisePhone, normaliseEmail, slug,
  extractDriveFileId, dedupeKey, validateIntake,
} = require('../n8n/src/lib/intake');

const CTX = {
  roles: ['Frontend Engineer', 'Backend Engineer'],
  categories: ['Intern', 'Junior', 'Senior'],
  correlationId: 'WF-01-TEST',
  applicantId: 'APP-20260814-AAAAAA',
  now: '2026-08-14T00:00:00.000Z',
};

const good = {
  name: '  Asha   Menon ',
  email: 'ASHA@Example.COM ',
  job_role: 'frontend engineer',
  category: 'junior',
  resume_link: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr/view?usp=sharing',
};

test('accepts and normalises a good row', () => {
  const r = validateIntake(good, CTX);
  assert.equal(r.ok, true);
  assert.equal(r.row.name, 'Asha Menon');
  assert.equal(r.row.email, 'asha@example.com');
  assert.equal(r.row.job_role, 'Frontend Engineer', 'snaps to canonical casing from JobRoles');
  assert.equal(r.row.category, 'Junior');
  assert.equal(r.row.resume_file_id, '1AbCdEfGhIjKlMnOpQr');
  assert.equal(r.row.stage, 'NEW');
  assert.equal(r.row.status, 'ok');
});

test('missing required fields are reported together, not one at a time', () => {
  const r = validateIntake({ ...good, name: '', job_role: '' }, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E-INTAKE-MISSING');
  assert.match(r.error.message, /name/);
  assert.match(r.error.message, /job_role/);
  assert.equal(r.row.status, 'blocked', 'blocked rows stay visible rather than being dropped');
});

test('rejects malformed emails', () => {
  for (const bad of ['nope', 'a@b', 'a b@c.com', '@x.com', 'a@@b.com', 'a@b..com']) {
    assert.equal(isValidEmail(bad), false, `${bad} should be invalid`);
  }
  for (const ok of ['a@b.co', 'first.last+tag@sub.example.com']) {
    assert.equal(isValidEmail(ok), true, `${ok} should be valid`);
  }
  const r = validateIntake({ ...good, email: 'not-an-email' }, CTX);
  assert.equal(r.error.code, 'E-INTAKE-EMAIL');
});

test('unknown role and category are typed differently', () => {
  assert.equal(validateIntake({ ...good, job_role: 'Astronaut' }, CTX).error.code, 'E-INTAKE-ROLE');
  assert.equal(validateIntake({ ...good, category: 'Wizard' }, CTX).error.code, 'E-INTAKE-CATEGORY');
});

test('duplicate detection is per email+role, not per email', () => {
  const seen = new Set([dedupeKey('asha@example.com', 'Frontend Engineer')]);
  assert.equal(validateIntake(good, { ...CTX, seen }).error.code, 'E-INTAKE-DUPE');
  // Same person, different role: allowed.
  const other = validateIntake({ ...good, job_role: 'Backend Engineer' }, { ...CTX, seen });
  assert.equal(other.ok, true);
});

test('non-http resume links are rejected before anything tries to fetch them', () => {
  assert.equal(validateIntake({ ...good, resume_link: 'C:\\resumes\\asha.pdf' }, CTX).error.code, 'E-FETCH-TYPE');
});

test('a blank resume link is allowed — V1 outreach does not need the file', () => {
  assert.equal(validateIntake({ ...good, resume_link: '' }, CTX).ok, true);
});

test('extracts Drive ids from every link shape Drive emits', () => {
  assert.equal(extractDriveFileId('https://drive.google.com/file/d/1AbCdEfGhIj/view'), '1AbCdEfGhIj');
  assert.equal(extractDriveFileId('https://drive.google.com/open?id=1AbCdEfGhIj'), '1AbCdEfGhIj');
  assert.equal(extractDriveFileId('https://docs.google.com/document/d/1AbCdEfGhIj/edit'), '1AbCdEfGhIj');
  assert.equal(extractDriveFileId('https://example.com/cv.pdf'), '', 'non-Drive URLs fetch over plain HTTP');
});

test('phone normalisation keeps a leading + and drops formatting', () => {
  assert.equal(normalisePhone(' +91 (98765) 43210 '), '+919876543210');
  assert.equal(normalisePhone('98765-43210'), '9876543210');
  assert.equal(normalisePhone('n/a'), '', 'unparseable becomes blank rather than garbage');
});

test('slug and email normalisation are stable', () => {
  assert.equal(slug('  Frontend  Engineer '), 'frontend-engineer');
  assert.equal(normaliseEmail('  A@B.COM '), 'a@b.com');
});
