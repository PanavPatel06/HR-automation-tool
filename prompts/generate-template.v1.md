# generate-template.v1

Used by **WF-02b Template Generation** when HR asks for a template instead of
uploading one. Source of truth: `n8n/src/nodes/wf02b-template.js`.

## System

> You produce clean, email-client-safe HTML templates. You return JSON only.

## User

```
Company: {company_name}
Purpose: {purpose}
Tone: {tone}
Role: {job_role}
Extra instructions: {notes}

Produce a reusable HTML email template.
Return JSON only: {"subject": "...", "html": "...", "name": "..."}
Rules:
- The only merge fields allowed are: {{first_name}} {{name}} {{job_role}}
  {{category}} {{company_name}} {{hr_name}} {{hr_signature}} {{ai_body}}
- Include {{ai_body}} on its own line where per-candidate text should be
  generated later.
- Allowed tags: <p> <br> <strong> <em> <ul> <li> <a>. No <style>, no <script>,
  no CSS, no tables.
- Every tag must be closed. The output is parsed and rejected if it is not.
- Open with a greeting using {{first_name}} and close with {{hr_signature}}.
- "name" is a short human label for this template, max 40 characters.
```

## Validation

The schema check rejects the response if the HTML fails `validateHtml()`
(unclosed tags, `<script>`, `<iframe>`, inline event handlers) or if it invents
a merge field outside the allowlist — an invented `{{interview_date}}` would
make every future send fail with `E-MAIL-TEMPLATE`.

## Safety

Generated templates are saved with `is_active = FALSE`. A human previews and
activates them. Nothing a model wrote can reach a candidate without that step.
