'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeHtml, extractFields, render, validateHtml, selectTemplate, renderEmail, buildMergeContext,
} = require('../n8n/src/lib/template');

const CONFIG = { company_name: '3Space', hr_name: 'Priya', hr_signature: 'Best,<br>Priya' };
const APPLICANT = { name: 'Asha Menon', email: 'asha@example.com', job_role: 'Frontend Engineer', category: 'Junior', applicant_id: 'APP-1' };

const tpl = (over = {}) => ({
  template_id: 'T1', name: 'Outreach', job_role: '', category: '', stage: 'outreach',
  subject: 'Your application for {{job_role}}',
  html: '<p>Hi {{first_name}},</p><p>Thanks for applying to {{company_name}}.</p><p>{{hr_signature}}</p>',
  is_active: 'TRUE', is_default: 'TRUE', ...over,
});

test('renders merge fields and derives first_name', () => {
  const out = renderEmail({ template: tpl(), applicant: APPLICANT, config: CONFIG });
  assert.equal(out.subject, 'Your application for Frontend Engineer');
  assert.match(out.html, /Hi Asha,/);
  assert.match(out.html, /3Space/);
});

test('escapes applicant-supplied values but not the trusted signature', () => {
  const out = renderEmail({
    template: tpl(),
    applicant: { ...APPLICANT, name: '<script>alert(1)</script> Bad' },
    config: CONFIG,
  });
  assert.ok(!out.html.includes('<script>'), 'applicant name must be escaped');
  assert.match(out.html, /&lt;script&gt;/);
  assert.match(out.html, /Best,<br>Priya/, 'hr_signature is trusted HTML and stays raw');
});

test('an unresolved merge field blocks the send instead of emailing "Hi {{name}},"', () => {
  const t = tpl({ html: '<p>Hi {{first_name}}, ref {{interview_date}}</p>' });
  assert.throws(
    () => renderEmail({ template: t, applicant: APPLICANT, config: CONFIG }),
    (e) => e.code === 'E-MAIL-TEMPLATE' && /interview_date/.test(e.message)
  );
});

test('an empty rendered subject is refused', () => {
  assert.throws(
    () => renderEmail({ template: tpl({ subject: '' }), applicant: APPLICANT, config: CONFIG }),
    (e) => e.code === 'E-MAIL-TEMPLATE' && /subject/i.test(e.message)
  );
});

test('validateHtml catches the ways generated HTML actually breaks', () => {
  assert.equal(validateHtml('<p>ok</p><br><img src="x">').ok, true, 'void tags need no closing');
  assert.equal(validateHtml('<p>hi').ok, false);
  assert.match(validateHtml('<p>hi').problems[0], /Unclosed/);
  assert.equal(validateHtml('<div><p>hi</div></p>').ok, false);
  assert.equal(validateHtml('<script>x</script>').ok, false);
  assert.equal(validateHtml('<a onclick="x()">y</a>').ok, false);
  assert.equal(validateHtml('').ok, false);
});

test('template selection prefers the most specific match', () => {
  const templates = [
    tpl({ template_id: 'default', is_default: 'TRUE' }),
    tpl({ template_id: 'role', job_role: 'Frontend Engineer', is_default: 'FALSE' }),
    tpl({ template_id: 'role+cat', job_role: 'Frontend Engineer', category: 'Junior', is_default: 'FALSE' }),
  ];
  assert.equal(selectTemplate(templates, { job_role: 'Frontend Engineer', category: 'Junior' }).template.template_id, 'role+cat');
  assert.equal(selectTemplate(templates, { job_role: 'Frontend Engineer', category: 'Senior' }).template.template_id, 'role');
});

test('falling back to the default template raises a warning, not an error', () => {
  const templates = [tpl({ template_id: 'default', is_default: 'TRUE' }), tpl({ template_id: 'other', job_role: 'Backend Engineer', is_default: 'FALSE' })];
  const r = selectTemplate(templates, { job_role: 'Frontend Engineer', category: 'Junior' });
  assert.equal(r.template.template_id, 'default');
  assert.equal(r.warning, 'W-TEMPLATE-DEFAULT');
});

test('inactive templates are invisible to selection', () => {
  assert.throws(
    () => selectTemplate([tpl({ is_active: 'FALSE' })], { job_role: 'X' }),
    (e) => e.code === 'E-MAIL-TEMPLATE'
  );
});

test('no matching role and no default is an error, not a silent wrong email', () => {
  const templates = [tpl({ template_id: 'be', job_role: 'Backend Engineer', is_default: 'FALSE' })];
  assert.throws(
    () => selectTemplate(templates, { job_role: 'Frontend Engineer' }),
    (e) => e.code === 'E-MAIL-TEMPLATE' && /no default/i.test(e.message)
  );
});

test('extractFields and escapeHtml behave', () => {
  assert.deepEqual(extractFields('{{a}} {{ b }} {{a}}'), ['a', 'b']);
  assert.equal(escapeHtml(`<&">'`), '&lt;&amp;&quot;&gt;&#39;');
});

test('V2-only merge fields render empty in V1 rather than throwing', () => {
  const ctx = buildMergeContext(APPLICANT, CONFIG);
  assert.equal(ctx.match_percent, '');
  assert.equal(render('{{match_percent}}', ctx).unresolved.length, 1, 'and are reported as unresolved if a template uses them');
});
