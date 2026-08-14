# Dashboard

Next.js App Router app. Deploys to Vercel Hobby (free) with
**Root Directory = `dashboard`**.

```
app/            pages (server components) + API routes
components/     client components
lib/sheets.ts   Google Sheets read/write — the whole data layer
lib/n8n.ts      HMAC signing and webhook calls
lib/contract.ts the column contract (mirrored; see below)
lib/auth.ts     session cookie
```

## How it talks to everything

**Reads** go straight to Google Sheets in server components. Every page is
`force-dynamic` — the sheet is the truth, so nothing is cached.

**Writes** split by destination:

| Action | Goes to | Why |
|---|---|---|
| Generate drafts, send, generate template, preflight | **n8n** | Side effects outside the sheet. n8n holds the secrets and re-validates every rule. |
| Approve, unapprove, toggle, activate template, resolve error | **Sheets directly** | Pure state changes. Approval in particular must never leave this process — it is the human gate. |

Calls to n8n are HMAC-signed over a canonically serialised body plus a
timestamp, with a 5-minute replay window. `N8N_WEBHOOK_SECRET` must be
byte-identical to n8n's, or everything is rejected with `E-CONFIG-CRED`.

## The mirrored contract

`lib/contract.ts` duplicates the column definitions from
`n8n/src/lib/schema.js`, because Vercel builds this directory alone and cannot
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

## Local development

```bash
cp .env.example .env.local && $EDITOR .env.local
npm install
npm run dev          # http://localhost:3000
npm run typecheck
npm run build
```

The dashboard reads live Sheets data in dev too, so use a scratch spreadsheet if
you are experimenting.

## Design notes

- **Failures are red and inline.** A failed row shows its code and message in the
  table. Debugging never requires opening n8n.
- **Partial success is shown as partial.** "8 succeeded, 2 failed" is not
  rendered as a green checkmark — that is how silent breakage starts.
- **Sending names every recipient** before it happens. There is no path from one
  click to "email everyone".
- **Dry run is visible on every page** that can send.
- Theme-aware (light/dark), no CSS framework, no client-side data fetching
  beyond actions.
