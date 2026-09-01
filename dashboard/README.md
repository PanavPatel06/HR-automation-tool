# Dashboard

The whole application. Next.js App Router, deployed from this directory alone.

```
app/page.tsx              the app — candidate list + composer
app/templates/            template library, AI template generation
app/console/              preflight checks + the send log
app/settings/             the Config toggles
app/api/action/route.ts   EVERY mutating action, and every safety gate
app/api/login|logout/     shared-password session

lib/contract.ts           hand-mirror of ../lib/schema.js (parity-tested)
lib/sheets.ts             all Sheets I/O + the demo dataset
lib/mailer.ts             all outbound email (Resend, over plain fetch)
lib/template.ts           merge fields, HTML validation, template choice, the branded shell
lib/groq.ts               the only model provider
lib/auth.ts               session cookie
```

Everything user-facing lives at `/`. `components/MailView.tsx` holds the
candidate list and the composer.

There are only three actions that matter, all in `app/api/action/route.ts`:

| Action | Writes? | What it does |
|---|---|---|
| `compose-template` | no | Fills a template with one candidate's row |
| `compose-ai` | no | Writes a message from a brief plus that row (name, role, category, notes) |
| `send` | yes | Delivers it, to one person or several, then logs it |

Neither compose action writes anything — they hand a draft back to the browser.
That is why there is no approval step: nothing can be sent that a person is not
looking at.

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
| `single && !template` | Sending to several people requires a template — a one-off message cannot be blasted to a list. |
| `FIELD_RE` leftover check | An unresolved `{{field}}` fails that recipient with a per-person error, after the merge. |
| `validateHtml()` | Rejects malformed or dangerous markup before it can be sent. |
| `EMAIL_RE` | A bad address is rejected without aborting the rest of the batch. |

EmailLog is appended **before** the Applicants patch, deliberately: if the sheet
write fails after a real send, the error says *"they have already gone out"* and
the audit row still exists.

`EmailLogRow` in the route is typed off the contract, because those rows are
built into an array and appended in a loop — out of reach of
`tests/write-columns.test.js`, which can only read literal `appendRow` sites. The
type gets the same guarantee at build time.

## Client/server boundary

`lib/sheets.ts`, `lib/mailer.ts`, `lib/groq.ts` and `lib/template.ts` are
marked `server-only`. Client components must import types
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
- A one-off (non-template) message goes to one recipient at a time, on purpose.
