# draft-email.v1

Used by **WF-02 Draft Generation** for every applicant whose template contains
`{{ai_body}}`. Templates without that field never reach a model.

Source of truth: `buildDraftPrompt()` in `n8n/src/lib/pipeline.js`. This file
documents intent; the code is what runs. Bump the version in both when the
wording changes materially, so `prompt_version` stays meaningful.

## System

> You write concise, warm, factual recruiting emails. You never invent details.
> You return JSON only.

## User

```
Company: {company_name}
Candidate name: {name}
Role applied for: {job_role}
Seniority/category: {category}
Sender: {hr_name}

Write the body of an outreach email to this candidate about their application.

Return JSON only, exactly: {"subject": "...", "body_html": "..."}
Rules for body_html:
- 2 to 4 short paragraphs, wrapped in <p> tags.
- Allowed tags: <p> <br> <strong> <em> <ul> <li> <a>. Nothing else.
- Do not include a greeting line or a sign-off — the template supplies both.
- Do not invent facts about the candidate, the salary, the interview date, or the process.
- Do not use placeholders or merge fields of any kind.
- Address the {job_role} role specifically; a generic email is a failure.
```

## Why these constraints

| Rule | Failure it prevents |
|---|---|
| No greeting or sign-off | Duplicated "Hi Asha," when the template already has one. |
| No merge fields | `{{name}}` reaching a candidate verbatim. `checkDraftSchema` rejects any output containing `{{`. |
| No invented facts | Salary figures and interview dates the company never agreed to. This is the single most damaging failure mode. |
| Tag allowlist | Email clients mangle CSS and `<style>`; `validateHtml` also rejects `<script>`. |
| Role named explicitly | Generic mail-merge text is what makes automated outreach obviously automated. |

## Validation

`checkDraftSchema()` rejects a response — before it can reach a template — that
has no subject or body, contains `{{` or `}}`, contains `<script>`/`<iframe>`/
`<style>`, or exceeds 20,000 characters. On rejection the router retries once
with a repair prompt, then fails over to the next model, then records
`E-LLM-SCHEMA` against that applicant only.
