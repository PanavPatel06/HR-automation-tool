# generate-template.v1

Used by the **template-generate** action when HR asks for a template instead
of uploading one. Source of truth: the `template-generate` branch of
`dashboard/app/api/action/route.ts`.

## System

> You produce clean, email-client-safe HTML templates. You return JSON only.

## User

```
Company: {company_name}
Purpose: {purpose}
Tone: {tone}
Role: {job_role}
Extra instructions: {notes}

Produce the BODY of a recruiting email template — a few short paragraphs, not
a full document. No <html>/<head>/<body>, no header, logo, or company contact
details: those are added automatically around whatever you return.
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

## The branded shell

The model never sees or writes the logo/header/footer — `renderSkeleton()`
(`dashboard/lib/template.ts`) wraps its returned `html` in 3Space's branded
skeleton server-side, right before the row is saved. Every template, seed or
AI-generated, ends up with byte-identical branding; only the message
paragraphs differ. This is deliberate: an LLM asked to reproduce an
inline-styled HTML table exactly, every time, is a much less reliable way to
get consistent branding than never asking it to.

## Safety

Generated templates are saved with `is_active = FALSE` — nothing runs an
automatic HTML/merge-field check on generation. A human previews the
template on the Templates page and activates it explicitly. If it does
invent a merge field outside the allowlist, that surfaces the first time
someone drafts or sends with it: `renderEmail()` (`dashboard/lib/template.ts`)
fails closed with `E-MAIL-TEMPLATE` rather than sending a broken email.
