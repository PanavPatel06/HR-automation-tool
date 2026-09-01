# Dashboard

The whole application. Next.js App Router, deployed from this directory alone.

```
app/page.tsx              the app — candidate list + per-candidate composer
app/templates/            template library, AI template generation
app/console/              preflight checks + the send log
app/settings/             the Config toggles
app/api/action/route.ts   EVERY mutating action, and every safety gate
app/api/login|logout/     shared-password session

lib/contract.ts           hand-mirror of ../lib/schema.js (parity-tested)
lib/duplicates.ts         repeated applicant_id / email detection
lib/sheets.ts             all Sheets I/O + the demo dataset
lib/mailer.ts             all outbound email (Resend, over plain fetch)
lib/template.ts           merge fields, HTML validation, template choice, the branded shell
lib/draft.ts              batch selection, draft prompt, model-output gate
lib/groq.ts               the only model provider
lib/auth.ts               session cookie
```

Everything user-facing lives at `/`. `components/MailView.tsx` is the single
biggest file and holds the candidate list, the bulk pipeline actions, and the
composer.

## Demo mode

With `SHEET_ID` or `GOOGLE_SERVICE_ACCOUNT_JSON` unset, `lib/sheets.ts` serves
an in-memory sample dataset instead of throwing (`isDemoMode()`). Reads and
writes both work — approve, toggle, send all behave like a real backend — but
nothing persists across a server restart, and nothing is emailed. It exists so
the app is fully explorable with zero Google Cloud setup, and so this repo can
be demonstrated without credentials.

Demo mode affects **data only**. Sending is gated separately by `dry_run` in
Config and by whether `RESEND_API_KEY`/`MAIL_FROM` are set, so the two can be
mixed in any combination.

## Where the safety gates are

All in `app/api/action/route.ts`:

| Gate | What it stops |
|---|---|
| `requireMailerWhenLive()` | Dry run off + no mailer → `503 E-CONFIG-MISSING`, **before** any row or log write. Never fakes a send. |
| `config.toggle_send === false` | The Settings master switch, enforced server-side, not just in the UI. |
| `send_daily_cap` vs EmailLog | Counted from the log, so it survives restarts. |
| `ACTIONABLE` + the stage machine | `DRAFTED → SENT` is refused with `E-STAGE`. |
| `FIELD_RE` leftover check | An unresolved `{{field}}` fails with `E-MAIL-TEMPLATE`. |
| `a.sent_at` | Duplicate-send guard. |
| `validateHtml()` | Rejects malformed or dangerous markup before it can be sent. |
| `set-email` collision check | Refuses to put one address on two rows, rather than only reporting it later. |

EmailLog is appended **before** the Applicants patch, deliberately: if the sheet
write fails after a real send, the error says *"the email has already gone out —
do not send it again"* and the audit row still exists.

## Client/server boundary

`lib/sheets.ts`, `lib/mailer.ts`, `lib/groq.ts`, `lib/draft.ts` and
`lib/template.ts` are marked `server-only`. Client components must import types
from them only as `import type`, which is erased at compile time. `MailView.tsx`
is a client component; every page under `app/` is a server component that reads
Sheets and passes plain data down.

Every model call happens server-side. No API key ever reaches the browser.

## Environment

See `.env.example`. Summary:

| Variable | Needed for |
|---|---|
| `DASHBOARD_PASSWORD`, `SESSION_SECRET` | Signing in. Always required. |
| `SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON` | Real data. Omit both for demo mode. |
| `GROQ_API_KEY` | Any AI action. |
| `RESEND_API_KEY`, `MAIL_FROM` | Real sending. Omit both to keep sends logged-only. |
| `COMPANY_LOGO_BASE_URL` | Only if the email logo isn't served from this deployment. |

## Adding a column

1. Add it to `../lib/schema.js`.
2. Add it to `lib/contract.ts` in the **same position**.
3. `npm test` from the repo root — `contract-parity.test.js` fails if they
   disagree, `write-columns.test.js` fails if the route writes a column that
   doesn't exist.
4. `npm run bootstrap:sheets` against the real spreadsheet, or every read of
   that tab fails with `E-SHEET-SCHEMA`.

Step 4 is the one people forget. The schema check is on *reads*, so a missing
column takes down the whole tab, not just the new feature.

## Known gaps

- One shared password rather than per-user sign-in. `lib/auth.ts` is where an
  OAuth provider would slot in.
- Every page reads whole tabs; no pagination.
- No reply ingestion — candidates reply to `company_email` and a human reads it.
- Nothing dedupes the sheet automatically; `lib/duplicates.ts` reports, it never
  deletes. Removing a row is a human decision.
