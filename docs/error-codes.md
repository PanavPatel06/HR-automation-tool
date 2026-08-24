# Error codes

Every failure carries one of these codes, a plain-English message, and a fix.
They're defined per concern, right where they're thrown: `SheetsError` in
`dashboard/lib/sheets.ts`, `GroqError` in `dashboard/lib/groq.ts`,
`GmailError` in `dashboard/lib/gmail.ts`, `TemplateError` in
`dashboard/lib/template.ts`. This document explains what each one means in
practice.

Codes appear inline in the dashboard's action-result banners, and in the
`error_code` column on `Applicants` for rows a bulk Draft/Send has touched.

## How to read a code

```
E-MAIL-TEMPLATE
│ │    └── the specific problem
│ └─────── the subsystem
└───────── E = error, W = warning (recorded, never fatal)
```

There's no automatic retry or failover layer — a failed action reports its
code and stops; the human who clicked the button decides whether to try
again. Batch actions (Draft, Send) isolate failures per row: one bad
applicant never blocks the rest of the batch.

---

## E-SHEET-* — Google Sheets

| Code | Cause | Fix |
|---|---|---|
| `E-SHEET-PERM` | No access to the spreadsheet, or it doesn't exist | Share the spreadsheet with the service account email as **Editor**. The single most common setup mistake. |
| `E-SHEET-SCHEMA` | A column is missing | `npm run bootstrap:sheets`. It appends missing columns without touching data. |
| `E-SHEET-429` | Rate limit | Wait a moment and refresh. Usually several tabs open at once. |

## E-CONFIG-* — setup

| Code | Cause | Fix |
|---|---|---|
| `E-CONFIG-MISSING` | A required environment variable is absent (`SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GROQ_API_KEY`, ...) | See `dashboard/.env.example`. Run **Console → Run preflight** for the full list. |
| `E-CONFIG-CRED` | A credential is present but invalid — malformed JSON, or Groq unreachable | Check the value is pasted correctly, and that outbound network access works. |

## E-LLM-* — the model layer (Groq)

| Code | Cause | Fix |
|---|---|---|
| `E-LLM-HTTP` | Groq returned a non-2xx response | Check `GROQ_API_KEY` and that the model id (`GROQ_MODEL`) is still current. |
| `E-LLM-JSON` | Groq's response wasn't parseable JSON | Usually transient — try the action again. |
| `E-LLM-SCHEMA` | The parsed JSON didn't pass the draft/reply schema check (missing subject, disallowed tag, leftover `{{placeholder}}`, ...) | A prompt or model-output problem, not a data problem. Try again; if it recurs for the same applicant, an unusual character in their name or role may be confusing the prompt. |
| `E-LLM-EMPTY` | Groq returned nothing usable | Try again. |

## E-MAIL-* — templates and sending

| Code | Cause | Fix |
|---|---|---|
| `E-MAIL-TEMPLATE` | Unresolved `{{field}}`, invalid HTML structure, or an empty subject | **Nothing was sent.** Fix the template or add the missing value. This check exists so `Hi {{first_name}},` never reaches a candidate. |

The Send action also rejects a row inline (without a shared error code, just
a message) for: wrong stage, no draft body, an undeliverable-looking
address, already sent, or the daily cap reached.

## E-GMAIL-* — sending transport

| Code | Cause | Fix |
|---|---|---|
| `E-GMAIL-AUTH` | OAuth refresh token revoked or scope insufficient | Re-run `npm run gmail:oauth` and update `GMAIL_REFRESH_TOKEN`. |
| `E-GMAIL-429` | Gmail rate limit | Wait a moment and try again. |
| `E-VALIDATION` | Attachments exceed the size cap | Trim attachments to under the limit shown in the message. |
| `E-ATTACHMENT-FETCH` | A template's `attachment_url` was unreachable or returned a non-2xx status when sending | Confirm the link is shared "Anyone with the link" and loads without signing in. |

## Request-level codes

Returned directly by `app/api/action/route.ts` for a malformed or
out-of-order request, before anything is read or written:

| Code | Cause |
|---|---|
| `E-AUTH` | Session expired — sign in again. |
| `E-BADREQ` | Request is missing a required field (e.g. no applicants selected). |
| `E-STAGE` | A bulk action (approve/unapprove) was attempted on rows not in a legal stage for it. |
| `E-NOTFOUND` | The applicant/template/config key named in the request doesn't exist. |
| `E-NOT-IMPLEMENTED` | An Inbox action that only works in demo mode was called against a real spreadsheet (ad-hoc reply sending — see [README.md#known-limitations](../README.md#known-limitations)). |

## W-* — warnings

Recorded for audit. Nothing is broken.

| Code | Means |
|---|---|
| `W-TEMPLATE-DEFAULT` | No role-specific template matched, so the default was used — a more generic email than intended. |

---

## E-UNKNOWN

An unclassified failure. The raw message is shown in the error banner —
check the server logs (Render/Vercel function logs) for the full stack trace.

Seeing this repeatedly for the same action means a failure mode worth giving
its own typed code.
