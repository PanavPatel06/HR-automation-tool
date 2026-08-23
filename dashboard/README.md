# Dashboard

Next.js App Router app. Deploys to Vercel Hobby (free) with
**Root Directory = `dashboard`**.

```
app/                    pages (server components) + API routes
app/page.tsx            the merged Applicants+Inbox page — pipeline table + per-candidate thread
app/api/gmail-attachment/  streams a real Gmail attachment back as a download
components/MailView.tsx    the merged page's client component — list, thread, compose
lib/sheets.ts           Google Sheets read/write — the whole data layer (+ demo-mode fallback)
lib/groq.ts             direct Groq client — the dashboard's only model provider
lib/gmail.ts            direct Gmail client — real import/send (optional)
lib/template.ts         merge-field rendering, HTML validation, template selection
lib/draft.ts            batch selection + prompt/schema logic for the Draft action
lib/contract.ts         the column contract (mirrored; see below)
lib/auth.ts             session cookie
```

Applicants and Inbox used to be two pages; they're one now (`/`, `MailView.tsx`) —
work the pipeline in bulk from the list (checkboxes, draft/approve/send, same
rules as before, plus grouping by stage/role/reply intent), or open one
candidate to see their whole thread and reply.

## How it talks to everything

**Reads** go straight to Google Sheets in server components. Every page is
`force-dynamic` — the sheet is the truth, so nothing is cached.

**Writes** split by destination:

| Action | Goes to | Why |
|---|---|---|
| Draft, send, generate template, preflight | **Sheets directly (+ Groq / Gmail)** | Runs in-process in `app/api/action/route.ts` — see `lib/draft.ts`, `lib/groq.ts`, `lib/gmail.ts`. No separate backend. |
| Approve, unapprove, toggle, activate template, resolve error, set category | **Sheets directly** | Pure state changes. Approval in particular must never leave this process — it is the human gate. |
| Inbox: load template into compose, AI reply draft | **Sheets directly (+ Groq)** | Pure read + a Groq call, no Sheets write — works with real Sheets too, as long as `GROQ_API_KEY` is set. |
| Inbox: send reply | **Sheets: demo mode only. Transport: Gmail if configured, else simulated.** — see below | The Sheets write (EmailLog) needs the demo store today; the Gmail *send* is a separate, optional gate. |
| Inbox: start a new conversation (`+ New`) | **Sheets directly, both modes** | Appends a fresh Applicants row (`appendRow()` in `lib/sheets.ts` — real `values.append` in real mode, in-memory push in demo mode) for someone not yet in the pipeline, so their thread can be opened and, if Gmail is configured, synced immediately. |

## Demo mode — running with zero setup

If `SHEET_ID` or `GOOGLE_SERVICE_ACCOUNT_JSON` is unset, `isDemoMode()` in
`lib/sheets.ts` goes true and every read/write falls through to an in-memory
sample dataset (`buildDemoStore()`) instead of talking to Google. It's seeded
once per server process and mutates in place, so approve / toggle / send-reply
all behave like a real backend for the life of that process — restart the dev
server and it resets.

Demo mode and real-Sheets mode run the same code paths for `draft`, `send`,
`template-generate` and `preflight` — the only thing that changes is whether
`lib/sheets.ts` talks to the in-memory store or the real Google Sheets API.
`send-reply` (the Inbox's ad-hoc reply) is the one action still demo-mode
only on its Sheets-write side; see the table above.

Every AI action needs `GROQ_API_KEY` in `dashboard/.env.local`; without it
they fail with a clear `E-CONFIG-MISSING` rather than a silent no-op.

### How Groq requests are actually sent

`lib/groq.ts` is the dashboard's only model provider — no failover, no
quota tracking, just one free-tier key. Per call, it:

1. Reads `GROQ_API_KEY` (required) and `GROQ_MODEL` (defaults to
   `llama-3.1-8b-instant`) from the server-side environment.
2. `POST`s to `https://api.groq.com/openai/v1/chat/completions` — Groq's
   OpenAI-compatible chat completions endpoint — with `Authorization: Bearer
   <key>`, `temperature: 0.4`, a system message forcing JSON-only output, and
   the caller's prompt as the user message.
3. Extracts the outermost `{...}` from the model's reply (in case it wrapped
   the JSON in prose) and parses it.
4. Turns any failure — missing key, network error, non-2xx response,
   unparsable JSON — into a `GroqError` with a stable `code`/`hint`, shown
   verbatim in the dashboard's error banner.

It's called from `app/api/action/route.ts` (`draft`, `template-generate`,
Inbox's `reply-ai-draft`), always server-side only —
`lib/groq.ts` imports `server-only`, so it can't end up in a client bundle.
Every generated subject/body is re-rendered through `lib/template.ts`'s merge
gate before it's shown or sent, so a model that echoes a literal `{{field}}`
back gets caught rather than reaching a candidate.

**If Groq calls 401 with a key that looks correct:** something else in your
shell already has `GROQ_API_KEY` set and is shadowing `.env.local` — Next's
env loader never overrides a variable already present in `process.env` when
the process starts. `npm run dev` guards against this itself
(`unset GROQ_API_KEY; next dev`), but if you run `next dev` some other way,
check `env | grep GROQ_API_KEY` in that exact shell first.

## Gmail — real import & send

Optional, and independent of everything above: set `GMAIL_CLIENT_ID`,
`GMAIL_CLIENT_SECRET` and `GMAIL_REFRESH_TOKEN` and the Inbox's **Sync from
Gmail** button pulls a candidate's real thread (searched by their email
address), and **Send** delivers a real email — with attachments — instead of
a simulation. Leave them unset and the Inbox behaves exactly as it does in
demo mode, whether or not `SHEET_ID` is set: the two are independently gated,
so you can run the pipeline data in demo mode while testing real Gmail
against one real address.

**One-time setup** (needs a human with browser access — this can't be
scripted end to end):

1. In [Google Cloud Console](https://console.cloud.google.com), same project
   as Sheets: enable the **Gmail API**, then create an **OAuth client ID**
   (Credentials → Create Credentials), application type **Desktop app**.
2. Add the Gmail address you're granting access to as a **Test user** on the
   OAuth consent screen (unless the app is published/verified).
3. From the repo root: `npm run gmail:oauth -- <client-id> <client-secret>`.
   It prints a consent URL — open it, approve, and the script prints the
   three values to paste into `dashboard/.env.local`.

**Safety:** Gmail being configured is not the same as consenting to send real
mail. Both `send-reply` and the bulk `send` action check the same `dry_run`
Config flag — real Gmail sending only happens when `dry_run` is off in
Settings; otherwise it's logged, not delivered. There is no separate "go
live" switch to remember — it's the one that already exists.

**What's real:**
- Import searches `to:<email> OR from:<email>` and parses each message's
  HTML/text body and attachment metadata (`lib/gmail.ts`).
- Send builds a real multipart MIME message (HTML + plain-text alternative,
  plus any attached files) and calls `users.messages.send`, threaded via
  `threadId` when replying into an imported thread.
- Attachments: `MailView.tsx` reads local files as base64 client-side (15MB
  total cap, enforced both client- and server-side) and sends them as normal
  JSON fields in the `send-reply` action — no separate upload endpoint.
  Attachments on *imported* messages download through
  `app/api/gmail-attachment/route.ts`, which streams the real bytes back as a
  normal browser download.

**What's deliberately not built:** syncing real Gmail labels (the Inbox's
"Group by" uses your existing `stage`/`job_role`/reply-intent fields, not
Gmail labels), push/live updates (import is a manual click, not a
subscription), and enterprise-grade MIME edge cases (inline images, exotic
character sets). `lib/gmail.ts`'s `GmailError` codes (`E-GMAIL-AUTH`,
`E-GMAIL-429`, ...) surface in the same error banner as everything else if
something goes wrong.

## The mirrored contract

`lib/contract.ts` duplicates the column definitions from `../lib/schema.js`
at the repo root, because Vercel builds this directory alone and cannot
reach outside it.

Duplication is only safe if it cannot drift silently, so
`tests/contract-parity.test.js` at the repo root fails the build if the two
disagree. **Change both together.**

## Authentication

A shared team password plus an HMAC-signed session cookie (12 hours). No OAuth
app to register, no extra dependency, nothing to pay for.

It authenticates the **team**, not the individual — which is why `approved_by`
records `dashboard` rather than a person.

Upgrade to per-user sign-in when you need attribution or clean offboarding:

1. `npm i next-auth`
2. Add the Google provider with an `allowlist` of HR email addresses in the
   `signIn` callback.
3. Replace `requireSession()` in `lib/auth.ts` with NextAuth's `auth()`.
4. Set `approved_by` from the session email in `app/api/action/route.ts`.

The rest of the app is unaffected — auth is only touched in those two places.

## Theme

Light/dark is user-controlled, not just OS-driven: the toggle button in the nav
(top right) sets `data-theme` on `<html>` and persists the choice to
`localStorage`, overriding `prefers-color-scheme` in either direction. A
blocking inline script in `app/layout.tsx` applies the stored value before
first paint, so there's no flash of the wrong theme on reload.

## Local development

```bash
cp .env.example .env.local && $EDITOR .env.local
npm install
npm run dev          # http://localhost:3000
npm run typecheck
npm run build
```

Leave `SHEET_ID` / `GOOGLE_SERVICE_ACCOUNT_JSON` blank to run in demo mode (see
above) — no Google Cloud setup needed. Add `GROQ_API_KEY` (and optionally
`GROQ_MODEL`) too if you also want to exercise the AI features locally, and
the three `GMAIL_*` variables (`npm run gmail:oauth` at the repo root) for
real Gmail import/send in the Inbox — see the Gmail section above.

The dashboard reads live Sheets data in dev when real credentials are set, so
use a scratch spreadsheet if you are experimenting against production data.

## Design notes

- **Failures are red and inline.** A failed row shows its code and message in the
  table.
- **Partial success is shown as partial.** "8 succeeded, 2 failed" is not
  rendered as a green checkmark — that is how silent breakage starts.
- **Sending names every recipient** before it happens. There is no path from one
  click to "email everyone".
- **Dry run is visible on every page** that can send.
- Theme-aware (light/dark, user-toggleable — see above), no CSS framework, no
  client-side data fetching beyond actions.
