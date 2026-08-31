# HR Automation — V1

Hiring outreach, automated end to end: applicants land in a Google Sheet, HR
generates a role-appropriate email draft with one click, reviews and sends it
from a dashboard, and replies come back classified.

Runs entirely on free tiers, with no separate backend to host. **Status: V1
complete.** V2 (resume parsing and match scoring) is planned but not built —
see [PLAN.md](PLAN.md).

> **New to JavaScript?** [LEARN.md](LEARN.md) is a Python-to-JavaScript path
> built around this codebase. Start there rather than with a generic tutorial.
> It predates this architecture, so some file references are stale — see the
> note at the top of that file.

```
Google Form ─┐
             ├─▶ Google Sheets ◀──▶ Next.js dashboard ──▶ Groq
Manual entry ─┘   (source of truth)  (review + drafts)     │
                        ▲                    │              │
                        └────────────────────┴──▶ Gmail ──▶ candidate
```

The dashboard is the only server-side piece: it reads and writes the sheet
directly, calls Groq to draft, and calls Gmail to send — all in the same
request a person triggers by clicking a button. Nothing polls on a schedule
and nothing runs unattended.

---

## What it does

| | |
|---|---|
| **Drafting** | Click **Draft**: picks the most specific matching template, then asks Groq to personalise it — but only for templates that opt in with `{{ai_body}}`. |
| **Review** | Every draft is previewed and approved by a human. Nothing sends without approval. |
| **Sending** | Click **Send**: goes via Gmail, per-recipient isolated, with a daily cap and a dry-run mode that is **on by default**. |
| **Replies** | Open a candidate's thread in the Inbox to see what they said, reply by template, by hand, or with AI. Classification and flagging are manual for now — see [Known limitations](#known-limitations). |
| **Observability** | Every failure has a typed code, a plain-English message, and a fix. The Console page is the whole debugging surface. |
| **Inbox (dashboard)** | A real, per-candidate mail view: import a candidate's actual Gmail thread on demand, reply by template/manually/with AI, attach files, categorise. Optional and independent of everything above — see [Connecting real Gmail to the Inbox](#connecting-real-gmail-to-the-inbox). |

---

## Requirements

| | |
|---|---|
| **Node** | 20 or newer (developed on 25) |
| **Google account** | For the spreadsheet and the sending mailbox |
| **Groq API key** | free — [console.groq.com/keys](https://console.groq.com/keys) |
| **Vercel account** | free, for the dashboard |

No server to provision and no Docker — the dashboard is the whole backend,
and it deploys to Vercel like any Next.js app.

---

## Quick start

Full step-by-step detail is in [Deployment](#deployment) below; this is the
skeleton.

### 1. Get the code

```bash
git clone <your-repo-url> hr-automation
cd hr-automation
npm install
npm test          # library tests, no credentials needed
```

### 2. Google: spreadsheet + service account

1. Create a blank Google Sheet. Copy its id from the URL
   (`docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`).
2. In [Google Cloud Console](https://console.cloud.google.com): new project →
   enable **Google Sheets API** → create a **service account** → create a **JSON key**.
3. **Share the spreadsheet with the service account's email as Editor.** This is
   the step everyone forgets; without it every read fails with `E-SHEET-PERM`.

```bash
cp .env.example .env
$EDITOR .env      # set SHEET_ID and GOOGLE_APPLICATION_CREDENTIALS

npm run bootstrap:sheets      # creates all 9 tabs, headers and Config defaults
npm run seed:demo             # optional: 3 roles, a default template, 3 demo applicants
```

`bootstrap:sheets` is idempotent — re-run it any time. It is also the fix for
`E-SHEET-SCHEMA`.

### 3. Dashboard

```bash
cd dashboard
cp .env.example .env.local && $EDITOR .env.local
npm install && npm run dev        # http://localhost:3000
```

Deploy to Vercel with **Root Directory = `dashboard`**, and set the same
environment variables there.

Leave `SHEET_ID` / `GOOGLE_SERVICE_ACCOUNT_JSON` blank to explore the dashboard
in **demo mode** first — an in-memory sample dataset, no Google Cloud setup
required. See [dashboard/README.md](dashboard/README.md#demo-mode--running-with-zero-setup).

### 4. Dashboard's own Gmail — optional

The dashboard's **Inbox** page can talk to Gmail directly — importing a
candidate's real thread on demand and sending real mail, both the bulk Send
action and ad-hoc replies. This is optional; skip it and sending stays
logged-only in EmailLog, never actually delivered.

```bash
# from the repo root, after creating an OAuth client ID (Desktop app) in the
# same Google Cloud project as step 2 — see dashboard/README.md#gmail--real-import--send
# for the exact console steps
npm run gmail:oauth -- <client-id> <client-secret>
```

It prints a consent URL; open it, approve, and paste the three
`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` values it
prints into `dashboard/.env.local` (and into Vercel's environment variables
for production). Full detail: [Connecting real Gmail to the Inbox](#connecting-real-gmail-to-the-inbox) below.

### 5. First run

1. Open the dashboard → **Console** → **Run preflight**. Everything should be green.
2. Add a row to the Applicants tab: `applicant_id`, `name`, `email`, `job_role`
   (must match a row in JobRoles), `stage` = `NEW`. (`npm run seed:demo` does
   this for you.)
3. Select it → **Draft** → review the generated email.
4. **Approve** it.
5. **Settings** → turn on *Sending*. Leave **dry run ON**.
6. Select the row → **Send**. Check the EmailLog tab: a `dry_run=true` entry,
   no email actually sent.
7. When the dry run looks right: **Settings** → **Go live**, then send for real.

---

## Deployment

Nothing above was "local dev" versus "production" — the same steps *are* the
deployment. Start to finish, roughly 15 minutes. Order matters — each step
verifies the one before it. There is one deployable piece: the dashboard.
Sheets needs no deployment of its own — it's already live the moment you
create it.

### 1. Google: spreadsheet, service account, Gmail

#### 1.1 The spreadsheet

Create a blank Google Sheet. From its URL:

```
https://docs.google.com/spreadsheets/d/1AbC...XyZ/edit
                                      └──── SHEET_ID ────┘
```

#### 1.2 Service account

1. [Google Cloud Console](https://console.cloud.google.com) → create a project.
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → Credentials → Create credentials → Service account.**
   Name it `hr-automation`. No roles needed — access comes from sharing the
   sheet, not from IAM.
4. Open the service account → **Keys → Add key → Create new key → JSON**.
   Download it. This file is a credential; treat it like a password.
5. Copy the service account's email (`hr-automation@<project>.iam.gserviceaccount.com`).

#### 1.3 Share the sheet — do not skip this

Open the spreadsheet → **Share** → paste the service account email → **Editor** →
Send.

Every `E-SHEET-PERM` traces back to this step.

#### 1.4 Create the tabs

On your laptop:

```bash
cd hr-automation
npm install
cp .env.example .env
```

Set in `.env`:

```
SHEET_ID=1AbC...XyZ
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```

Then:

```bash
npm run bootstrap:sheets
npm run seed:demo          # optional but recommended for a first run
```

You should see the 9 tabs created with headers and Config defaults. Re-run any
time — it never overwrites existing values.

Verify at any point with `npm run check:sheets`, which reports drift and
changes nothing.

#### 1.5 The sending mailbox

Use a real Google account HR owns — replies land in the same inbox. A
dedicated `hiring@` account is tidier than a personal one.

#### 1.6 API key

| Key | Where | Notes |
|---|---|---|
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) | Free. The dashboard's only model provider. |

### 2. Dashboard

The dashboard is a standard Next.js app — deploy it anywhere that runs
Node 20+. Two options below: Render (free, one blueprint file, what this repo
ships pre-configured for) and Vercel (also free, zero-config for Next.js).
Either works; there is nothing else to run alongside it.

#### 2.1 Local, first

```bash
cd dashboard
cp .env.example .env.local
$EDITOR .env.local
npm install
npm run dev
```

```
SHEET_ID=                     # same as step 1
GOOGLE_SERVICE_ACCOUNT_JSON=  # the WHOLE json file, on one line, in single quotes
GROQ_API_KEY=                 # from 1.6
DASHBOARD_PASSWORD=           # what the HR team will type
SESSION_SECRET=               # openssl rand -hex 32
```

Open `http://localhost:3000` → **Console** → **Run preflight** before
deploying anywhere. Leave `SHEET_ID`/`GOOGLE_SERVICE_ACCOUNT_JSON` blank to
try it in demo mode first (no Google Cloud setup needed).

#### 2.2 Render

This repo ships `render.yaml` at its root, so Render can build the whole
thing from a **Blueprint** without any manual service configuration:

1. Push the repo to GitHub (or GitLab).
2. [dashboard.render.com/blueprints](https://dashboard.render.com/blueprints) →
   **New Blueprint Instance** → pick the repo. Render reads `render.yaml`
   and creates one free web service rooted at `dashboard/`.
3. It will prompt for the env vars marked `sync: false` in `render.yaml` —
   paste in the same values as `.env.local` above (`GOOGLE_SERVICE_ACCOUNT_JSON`
   pastes as raw JSON, no extra quoting needed). Blanks are fine for the ones
   marked optional there.
4. **Apply** — it builds with `npm install && npm run build` and starts with
   `next start -p $PORT` (Render assigns the port; the blueprint already
   passes it through).

The blueprint pins **`branch: main`**, so a push to `main` is what deploys —
work on a branch, merge, and the deploy follows. It also sets
`healthCheckPath: /login`, because `/` answers 307 (redirect to sign-in) when
signed out and Render would read that as unhealthy.

Free-tier Render services **spin down after ~15 minutes idle** and take a
few seconds to wake on the next request — fine here, since every action in
this app is triggered by a person clicking something, not a background
schedule waiting to be missed.

If you'd rather configure it by hand instead of the blueprint: **New → Web
Service** → same repo → **Root Directory: `dashboard`** → **Build Command:
`npm install && npm run build`** → **Start Command: `npm start -- -p $PORT`**
→ add the same env vars → **Create Web Service**.

#### 2.3 Vercel (alternative)

1. Import the repo at [vercel.com/new](https://vercel.com/new).
2. **Root Directory → `dashboard`.** Without this the build fails.
3. Add the same environment variables (from `dashboard/.env.example`) under
   **Settings → Environment Variables**.
4. Deploy.

For `GOOGLE_SERVICE_ACCOUNT_JSON` paste the file contents directly into the
value box — no quotes, no escaping. Vercel handles the newlines.

### 3. Verify end to end

Work through this in order against your deployed URL.

| # | Do | Expect |
|---|---|---|
| 1 | Dashboard → **Console** → **Run preflight** | All checks green (or only the `Gmail configured` warning if you haven't set up Gmail). |
| 2 | Add a row to Applicants: `applicant_id`, `name`, `email`, `job_role`, `stage`=`NEW`, `status`=`ok` | Appears on the dashboard as **NEW**. |
| 3 | Select it → **Draft** | Stage becomes **DRAFTED**, with a rendered subject/body and no `{{fields}}` left. |
| 4 | **Approve** | Stage **APPROVED**. |
| 5 | Settings → turn on *Sending*. Keep **dry run ON**. Select → **Send** | EmailLog gets a `dry_run=true` row. **No email arrives.** |
| 6 | Settings → **Go live** → send to your own address | The email arrives. `thread_id` is populated. |

If any step fails, the code on the Console page names the cause. See
[Runbook](#runbook), organised by symptom.

### 4. Shipping a change

Push to `main` and Render rebuilds. One extra step, only when a release adds
a sheet column:

```bash
npm run check:sheets        # names any column the sheet is missing
npm run bootstrap:sheets    # appends them; never touches existing values
```

The sheet is the database, and the dashboard refuses to read a tab whose
columns don't match the contract — that's `E-SHEET-SCHEMA`, and it fails
*every* read of that tab, not just the new feature. Run the check after
pulling and the deploy stays boring.

### 5. Keeping it running

**Backups.** The spreadsheet is the data, and Google versions it
automatically. Also back up the service-account JSON and your `.env`/env-var
values somewhere outside the deploy platform.

**Uptime, if you care about cold starts.** A free
[UptimeRobot](https://uptimerobot.com) monitor hitting the dashboard URL
every few minutes keeps a free Render service from spinning down between
uses.

### Costs

| | |
|---|---|
| Render free tier / Vercel Hobby | $0 |
| Google Sheets + Drive | $0 |
| Groq free tier | $0 |
| Gmail sending | $0 (~500/day) |

---

## Everyday use

| Task | Where |
|---|---|
| Add applicants | The Applicants tab, or a Google Form pointed at it. Give each new row an `applicant_id`, `stage` = `NEW`, and `status` = `ok` — see [Known limitations](#known-limitations). |
| Change email wording | **Templates** page — upload HTML or generate one. |
| Approve and send | **Inbox** page — work the list in bulk, or open one candidate. |
| See what candidates said, reply | **Inbox** page — open a candidate's thread. |
| Something is wrong | **Console** page. Start with **Run preflight**. |
| Turn Drafting/Sending off | **Settings** page. Takes effect on the next click, no redeploy. |

### Templates and the AI opt-in

A template is plain HTML with `{{merge_fields}}`:

```html
<p>Hi {{first_name}},</p>
{{ai_body}}
<p>{{hr_signature}}</p>
```

`{{ai_body}}` is the switch. **With it**, Groq writes 2–4 personalised
paragraphs for each candidate when you click **Draft**. **Without it**, the
template renders deterministically and costs zero tokens. Since the free-tier
daily token budget is the real constraint, this is how you decide where
personalisation is worth spending it.

Available fields: `first_name` `name` `email` `job_role` `category`
`company_name` `hr_name` `hr_signature` `ai_body` `company_email`
`company_phone` `company_incubator`.

An email with an unresolved `{{field}}` is **never sent** — it fails as
`E-MAIL-TEMPLATE` first. `Hi {{first_name}},` reaching a candidate is worse than
a visible error.

### The branded skeleton

Every template — the seed default and every AI-generated one — is wrapped in
the same shell, following the company letterhead: monochrome, square-cornered,
hairline rules, wide-tracked caps. A black top strip, the logo with a contact
block opposite it (`{{company_email}}` / `{{company_phone}}` /
`{{company_incubator}}`), a rule, the message, then a small uppercase footer
line. It's table-based with every style inline rather than a `<style>` block,
which is the only markup that renders identically in Gmail, Outlook, and
everything else.

`renderSkeleton()` in `dashboard/lib/template.ts` does the wrapping — the AI
template-generation prompt only ever writes the message paragraphs, never the
header/footer, so branding can't drift between templates or get mangled by a
model. Edit `TEMPLATE_SKELETON` there to change the look (and its hand-mirror
in `scripts/bootstrap-sheets.mjs`'s seed — see the comment on `templateHtml`
for why it's duplicated). The contact fields are ordinary Config values,
editable in **Settings** exactly like `company_name`.

**The logo.** It lives at `dashboard/public/brand/logo.png` and needs no
setup — templates reference `{{company_logo_url}}`, and `resolveLogoUrl()`
resolves that per send to `<deployment origin>/brand/logo.png`, reading the
origin Render and Vercel already publish (`RENDER_EXTERNAL_URL` /
`VERCEL_URL`). Set `company_logo_url` in **Settings** only to point somewhere
else; `COMPANY_LOGO_BASE_URL` overrides the origin if it's ever guessed wrong.

Two things that look like details and are not:

- `/brand/*` sits outside the session gate in `middleware.ts`, because mail
  clients fetch images anonymously — behind the gate the logo reaches
  candidates as a broken image.
- The URL resolves per send rather than being baked into each stored
  template, so moving the dashboard to a new domain doesn't strand templates
  that were already generated. `resolveLogoUrl()` never returns empty: an
  unresolved merge field fails the send closed, and a missing logo is not a
  reason to stop an email going out.

To swap the artwork, overwrite `logo.png` — trimmed, transparent, ~450px
wide (it renders at 150px; the extra pixels are for retina). See
`dashboard/public/brand/README.md`.

Hand-written templates (uploaded or typed directly into the Templates tab)
are untouched — the skeleton only wraps the seed template and new AI drafts,
so nothing rewrites HTML a person already reviewed and activated.

### Attaching a file to a template

Open a template's preview on the **Templates** page and paste a file's URL
(e.g. a Google Drive link shared **"Anyone with the link"**) into
**Attachment URL**, then **Save attachment**. That file is fetched fresh and
attached to every email sent with that template — bulk **Send** and the
Inbox's per-candidate send both carry it, with no per-applicant upload.

There's no file upload in the dashboard itself: it stores a link (`Templates`
column `attachment_url`, plus optional `attachment_name` for the filename
shown to the recipient), not the bytes, so this needs no extra Google API
scope beyond what Sheets/Gmail already use. Same 15MB cap as manual Inbox
attachments (`MAX_ATTACHMENTS_BYTES` in `dashboard/lib/gmail.ts`); a link that
returns an error or a too-large file fails the send with `E-ATTACHMENT-FETCH`
or `E-VALIDATION` rather than sending without it.

---

## Connecting real Gmail to the Inbox

Setup is [step 4](#4-dashboards-own-gmail--optional) above. This is what it
actually does once connected.

**It loads one candidate's conversation, on demand — not your whole mailbox.**
Open a candidate's thread in the Inbox and click **⟳ Sync from Gmail**: the
dashboard searches Gmail for `to:<their email> OR from:<their email>`, pulls
every matching message (up to 20, oldest first), and merges them into that
one thread view. Nothing loads automatically on page load, nothing polls in
the background, and no other candidate's mail is touched. That's deliberate —
it's a single, narrow query per click rather than a standing subscription, so
there's no push-notification infrastructure to run (no Cloud Pub/Sub topic,
no public webhook endpoint, no watch-renewal cron) and no risk of pulling in
mail that has nothing to do with hiring.

If you want it to feel more automatic, two easy upgrades exist without adding
any new infrastructure — ask if you want either built:
- **Sync on open** — call the same sync automatically the moment you select a
  candidate, instead of requiring the button click.
- **Sync all** — a bulk action that loops the same per-candidate search over
  every applicant with an email. Fine for tens of candidates; for hundreds,
  Gmail's API quota means it should run in batches, not all at once.

A true always-on inbox (new mail appears without any click at all) needs
Gmail's push notifications (`users.watch` + a Cloud Pub/Sub topic + a public
HTTPS endpoint to receive them, re-registered every 7 days) — a real feature,
not a config change, and out of scope unless you want it as a dedicated
follow-up.

**Sheet structure — nothing extra needed.** The Applicants tab already has
everything this depends on:

| Column | Role in Gmail sync |
|---|---|
| `email` | The only thing sync searches by. As long as a row has a real address, its thread can be pulled in — no matter how that row was created (form, manual entry, or the Inbox's own "+ New" button for someone not yet in the pipeline). |
| `thread_id`, `message_id` | Filled in automatically the first time you send for real from that row. Used to keep a reply in the *same* Gmail thread instead of starting a new one. Blank until then — sync doesn't need them, it always searches by address. |

So the practical workflow for a real inbound email from someone not yet an
applicant: add them with the Inbox's **+ New** button (name + email is
enough), then **Sync from Gmail** on their new thread to pull in what they
already sent. No sheet changes, no import script.

---

## Architecture

How the pieces fit, and the reasoning behind the choices that are not obvious.

```
  Google Form ──┐
                ├──▶  Google Sheets  ◀──────────────┐
  Manual entry ─┘     (source of truth)             │
                             ▲                       │ read
                             │ read/write            │
              ┌──────────────┴────────────────────┐  │
              │        Next.js dashboard           │  │
              │        (Vercel free tier)          │  │
              │  Draft   ──▶ Groq                  │  │
              │  Send    ──▶ Gmail ───▶ candidate ─┘  │
              │  Inbox   ◀── Gmail ◀── (reply, on demand)
              │  Preflight, approve, settings — all in-process
              └─────────────────────────────────────┘
```

### The two actors

**Google Sheets is the source of truth.** Not a cache, not a mirror. If the
dashboard is down, HR can still see every candidate and work by hand in the
sheet directly. That property is worth more than the performance a real
database would buy at this scale.

**The dashboard is the whole backend.** It reads and writes Sheets, calls
Groq to draft, and calls Gmail to send — all inside the same request a
person triggers by clicking a button. There is no separate service holding
secrets or running on a schedule; every side effect happens because a human
clicked something, in the request that click made.

This is a deliberate simplification from an earlier design that split
"trigger" (dashboard) from "does the side effect" (a workflow engine) across
two deployed services connected by a signed webhook. That split earns its
keep once there's scheduled, unattended work — polling a mailbox, watching
for new form rows — which V1 does not have: every action here is a person
looking at a screen and clicking a button, so the two-service split was
pure overhead. See [Known limitations](#known-limitations) for what that
trade gives up (no automated intake, no scheduled reply polling).

### Where logic lives

```
lib/schema.js              the sheet contract: tabs, columns, the stage machine
scripts/                    sheet bootstrap, Gmail OAuth setup
dashboard/                  the whole app — Next.js, deploys to Vercel/Render
  app/api/action/route.ts     every mutating action — draft, send, approve, ...
  lib/contract.ts             the same contract, mirrored by hand (see below)
  lib/template.ts             merge-field rendering, HTML validation, template selection
  lib/draft.ts                batch selection + the Groq prompt/schema gate for Draft
  lib/groq.ts                 the Groq client
  lib/gmail.ts                the Gmail client
tests/                      library tests, no network or credentials required
prompts/                    every prompt, versioned
```

`lib/schema.js` at the repo root is the single source of truth for the
sheet's tab names, columns and stage machine — read by
`scripts/bootstrap-sheets.mjs` and the tests. The dashboard deploys from
`dashboard/` alone and cannot import outside that directory, so
`dashboard/lib/contract.ts` duplicates the same definitions by hand;
`tests/contract-parity.test.js` fails the build if the two ever drift apart.

```bash
npm test                    # library tests
cd dashboard && npm run typecheck && npm run build   # the app itself
```

### The stage machine

```
NEW ──▶ DRAFTED ──▶ APPROVED ──▶ SENT ──▶ REPLIED ──▶ CLOSED
 │         │            │          │
 └─────────┴────────────┴──────────┴────▶ FAILED ──▶ (back to origin on retry)
```

`DRAFTED → SENT` is **not** a legal transition. Approval is a mandatory,
separate, human-only step, enforced in two places: `ACTIONABLE` in
`dashboard/lib/contract.ts` (what the UI will even attempt) and the `send`
action's own per-row stage check in `route.ts` (what actually runs, even if
someone calls the API directly). Two checks because it is the rule that
matters most.

### The AI layer

`lib/groq.ts` is the dashboard's only model provider: one function, one
free-tier key, no failover and no quota ledger. That's a real simplification
from a design with a Groq→Gemini failover chain and a persisted token-bucket
ledger — worth it at V1's volume (a few dozen drafts a day), and Groq
returns a plain rate-limit error if it isn't, rather than failing silently.
Add a second provider here if that ever actually bites.

Templates opt into AI per-field with `{{ai_body}}`: a template without it
renders deterministically and costs zero tokens, so quota is spent only
where personalisation matters — see `usesAi()` in `dashboard/lib/draft.ts`.

Every generated subject/body is re-rendered through the same merge-field
gate a hand-written template goes through (`renderEmail()` in
`dashboard/lib/template.ts`) before it's shown or sent, so a model that
echoes a literal `{{field}}` back gets caught rather than reaching a
candidate.

### Trust boundaries

| Boundary | Control |
|---|---|
| Browser → dashboard | Signed session cookie, HMAC-verified server-side |
| Dashboard → Google Sheets | Service account scoped to one spreadsheet |
| Dashboard → Gmail | OAuth on the HR mailbox (optional; unset and sending stays logged-only) |
| Model output → candidate | Schema check, then template render, then HTML validation, then human approval |

The last row is the important one: **three gates between what a model
writes and what a candidate reads**, the last of which is a person.

### What is deliberately not automated

- **Approval.** Every email is read by a human first.
- **Rejection.** No candidate is auto-rejected. V2 scoring will rank, not decide.
- **Follow-ups.** Nothing nags a silent candidate automatically.
- **Reply classification and intake normalisation.** Both were background
  jobs in an earlier design; for now, reading a reply and adding an
  applicant are both direct, manual actions in the dashboard — see
  [Known limitations](#known-limitations).

Each of these is cheap to automate and expensive to get wrong. A wrongly
auto-rejected strong candidate is an invisible loss — no error, no alert,
just a worse hire six weeks later.

### What V2 adds

V2 inserts two stages in front of the existing pipeline and reuses everything
else:

```
NEW ──▶ PARSED ──▶ SCORED ──▶ SHORTLISTED ──▶ DRAFTED ──▶ … (V1 unchanged)
```

The columns are already declared in `lib/schema.js` marked `v2: true`, and
the bootstrap creates them with `--v2`. V2 columns only ever *append*, so V1
column positions never move. See [PLAN.md](PLAN.md) §6.

---

## Safety properties

These are enforced in code, not just intended:

- **Nothing sends without human approval.** `DRAFTED → SENT` is not a legal transition; approval is a separate, human-only step.
- **Dry run ships ON**, and Sending ships OFF in Settings.
- **Bulk send names every recipient** in the request — there is no one-click "email everyone".
- **Unresolved merge fields block the send.**
- **One bad applicant never aborts a batch** — item-level isolation in both Draft and Send.
- **A model never decides an outcome.** It drafts; approving, rejecting and sending are human actions.

---

## Error codes

Every failure carries one of these codes, a plain-English message, and a fix.
They're defined per concern, right where they're thrown: `SheetsError` in
`dashboard/lib/sheets.ts`, `GroqError` in `dashboard/lib/groq.ts`,
`GmailError` in `dashboard/lib/gmail.ts`, `TemplateError` in
`dashboard/lib/template.ts`. Codes appear inline in the dashboard's
action-result banners, and in the `error_code` column on `Applicants` for
rows a bulk Draft/Send has touched.

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

### E-SHEET-* — Google Sheets

| Code | Cause | Fix |
|---|---|---|
| `E-SHEET-PERM` | No access to the spreadsheet, or it doesn't exist | Share the spreadsheet with the service account email as **Editor**. The single most common setup mistake. |
| `E-SHEET-SCHEMA` | A column is missing | `npm run bootstrap:sheets`. It appends missing columns without touching data. |
| `E-SHEET-429` | Rate limit | Wait a moment and refresh. Usually several tabs open at once. |

### E-CONFIG-* — setup

| Code | Cause | Fix |
|---|---|---|
| `E-CONFIG-MISSING` | A required environment variable is absent (`SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GROQ_API_KEY`, ...) | See `dashboard/.env.example`. Run **Console → Run preflight** for the full list. |
| `E-CONFIG-CRED` | A credential is present but invalid — malformed JSON, or Groq unreachable | Check the value is pasted correctly, and that outbound network access works. |

### E-LLM-* — the model layer (Groq)

| Code | Cause | Fix |
|---|---|---|
| `E-LLM-HTTP` | Groq returned a non-2xx response | Check `GROQ_API_KEY` and that the model id (`GROQ_MODEL`) is still current. |
| `E-LLM-JSON` | Groq's response wasn't parseable JSON | Usually transient — try the action again. |
| `E-LLM-SCHEMA` | The parsed JSON didn't pass the draft/reply schema check (missing subject, disallowed tag, leftover `{{placeholder}}`, ...) | A prompt or model-output problem, not a data problem. Try again; if it recurs for the same applicant, an unusual character in their name or role may be confusing the prompt. |
| `E-LLM-EMPTY` | Groq returned nothing usable | Try again. |

### E-MAIL-* — templates and sending

| Code | Cause | Fix |
|---|---|---|
| `E-MAIL-TEMPLATE` | Unresolved `{{field}}`, invalid HTML structure, or an empty subject | **Nothing was sent.** Fix the template or add the missing value. This check exists so `Hi {{first_name}},` never reaches a candidate. |

The Send action also rejects a row inline (without a shared error code, just
a message) for: wrong stage, no draft body, an undeliverable-looking
address, already sent, or the daily cap reached.

### E-GMAIL-* — sending transport

| Code | Cause | Fix |
|---|---|---|
| `E-GMAIL-AUTH` | OAuth refresh token revoked or scope insufficient | Re-run `npm run gmail:oauth` and update `GMAIL_REFRESH_TOKEN`. |
| `E-GMAIL-429` | Gmail rate limit | Wait a moment and try again. |
| `E-VALIDATION` | Attachments exceed the size cap | Trim attachments to under the limit shown in the message. |
| `E-ATTACHMENT-FETCH` | A template's `attachment_url` was unreachable or returned a non-2xx status when sending | Confirm the link is shared "Anyone with the link" and loads without signing in. |

### Request-level codes

Returned directly by `app/api/action/route.ts` for a malformed or
out-of-order request, before anything is read or written:

| Code | Cause |
|---|---|
| `E-AUTH` | Session expired — sign in again. |
| `E-BADREQ` | Request is missing a required field (e.g. no applicants selected). |
| `E-STAGE` | A bulk action (approve/unapprove) was attempted on rows not in a legal stage for it. |
| `E-NOTFOUND` | The applicant/template/config key named in the request doesn't exist. |
| `E-NOT-IMPLEMENTED` | An Inbox action that only works in demo mode was called against a real spreadsheet (ad-hoc reply sending — see [Known limitations](#known-limitations)). |

### W-* — warnings

Recorded for audit. Nothing is broken.

| Code | Means |
|---|---|
| `W-TEMPLATE-DEFAULT` | No role-specific template matched, so the default was used — a more generic email than intended. |

### E-UNKNOWN

An unclassified failure. The raw message is shown in the error banner —
check the server logs (Render/Vercel function logs) for the full stack trace.

Seeing this repeatedly for the same action means a failure mode worth giving
its own typed code.

---

## Runbook

Organised by symptom. For code definitions see [Error codes](#error-codes)
above.

**Always start here:** Dashboard → **Console** → **Run preflight**. It checks
every credential, environment variable and Config key without writing or
sending anything, and most problems are config drift.

### Applicants are not appearing

There is no automated intake step — a new row only appears on the dashboard
once it has an `applicant_id` and a `stage`.

1. **Did you set both?** Add the row directly to the Applicants tab with
   `applicant_id`, `name`, `email`, `job_role`, `stage` = `NEW`, `status` =
   `ok` already filled in. `npm run seed:demo` shows the exact shape.
2. **`job_role` matches JobRoles?** Not enforced automatically — if you want
   the row to show up with a valid role, `job_role` should match a `title`
   in the JobRoles tab.
3. **Wrong tab or a typo in a header cell?** `E-SHEET-SCHEMA` on the next
   read means a column name drifted — `npm run bootstrap:sheets` repairs it.

### Draft is not generating

1. **Settings → is *Drafting* on?**
2. **Is there an active template?** Templates page — at least one must be
   `active`, and one should be `default`. Without a match you get
   `E-MAIL-TEMPLATE: No template matches role "X" and no default template is set`.
3. **`GROQ_API_KEY` set?** Run preflight — it's the first check.
4. **`E-LLM-SCHEMA` or an HTTP error?** The model returned unusable JSON, or
   Groq rejected the request (bad key, rate limit). Click **Draft** again —
   drafting is per-applicant, so one failure doesn't block the rest of the
   batch.

### Emails are not sending

Work down this list — it is ordered by likelihood.

1. **Is *dry run* on?** Settings page. Dry runs write a `dry_run=true` row to
   EmailLog and send nothing. This is the intended default.
2. **Settings → is *Sending* on?** Ships off.
3. **Is the row `APPROVED`?** `DRAFTED` is not enough — approval is a
   separate, deliberate step. The Send action reports "not APPROVED" for
   any row that isn't.
4. **Unresolved `{{field}}` in the draft?** Nothing was sent, by design —
   fix the template or regenerate the draft.
5. **Daily cap hit** (`send_daily_cap`, default 400)? Resumes tomorrow.
6. **`E-GMAIL-AUTH`?** The OAuth refresh token expired or was revoked.
   Re-run `npm run gmail:oauth` and update `GMAIL_REFRESH_TOKEN`.
7. **Gmail not configured at all?** Sends stay logged-only forever — that's
   fine for evaluating the pipeline, but nothing actually leaves. Set
   `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` to send
   for real.
8. **One recipient failed, the rest went out?** Working as intended —
   per-recipient isolation. That row stays `APPROVED` and is retryable.

### Replies are not showing up

There is no automated reply watcher. Open the **Inbox** on a candidate's
thread and click **⟳ Sync from Gmail** — it searches for messages to/from
that address on demand. There's nothing to poll or wait for; if the message
genuinely isn't in the mailbox this pulls from, sync will find nothing to
show.

### The dashboard shows an error banner

| Message | Cause | Fix |
|---|---|---|
| *Permission denied reading the "X" tab* | Sheet not shared | Share with the service account as Editor |
| *missing column(s)* | Schema drift | `npm run bootstrap:sheets` |
| *GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON* | Truncated or escaped paste | Paste the whole file, unescaped |
| *GROQ_API_KEY is not set* | Missing env var | Add it to the dashboard environment and redeploy |
| *Gmail is not configured* | Missing Gmail env vars | Optional — set the three `GMAIL_*` vars, or ignore and stay in logged-only mode |

### An action reports partial success

*"Partly done — 8 succeeded, 2 failed"* is a normal outcome, not a bug. The
response's `errors` array names each one; the successes are already
committed to the sheet.

### Recovering a stuck row

| Situation | Do |
|---|---|
| Stuck in `FAILED` | Fix the underlying cause, then select it and **Draft** again. `FAILED` rows are eligible for drafting. |
| Sent by mistake | You cannot unsend. Set `stage` to `CLOSED` and handle it by hand. |
| Draft looks wrong | **Unapprove**, then **Draft** again — it overwrites the draft. |
| Reprocess from scratch | Clear `stage` and `status`, set `stage` back to `NEW`. |

### Changing the AI's behaviour

Edit the prompt in `dashboard/lib/draft.ts` (`buildDraftPrompt`) or the
inline prompt strings in `dashboard/app/api/action/route.ts`
(`reply-ai-draft`, `template-generate`), bump the version string alongside
it, then:

```bash
cd dashboard && npm run typecheck && npm run build
```

To change the model, edit `GROQ_MODEL` in the environment (defaults to
`llama-3.1-8b-instant`) — no code change needed.

### Rotating a secret

| Secret | How |
|---|---|
| `GROQ_API_KEY` | Update the dashboard's env var and redeploy. |
| Service account key | Create a new key, update `GOOGLE_APPLICATION_CREDENTIALS` locally and `GOOGLE_SERVICE_ACCOUNT_JSON` on the deploy platform. Delete the old key last. |
| `DASHBOARD_PASSWORD` | Change it on the deploy platform and redeploy. Existing sessions survive up to 12 hours; also change `SESSION_SECRET` to invalidate them immediately. |
| `GMAIL_REFRESH_TOKEN` | Re-run `npm run gmail:oauth` and update the three `GMAIL_*` values. |

### Deliberately breaking things (fault injection)

Worth doing once before you trust the system. Each should produce the named
code, visible in the action's error banner, with nothing else disturbed:

| Break this | Expect |
|---|---|
| Set `GROQ_API_KEY` to something wrong, click Draft | `E-LLM-*` on that applicant; other applicants in the batch still draft |
| Add `{{interview_date}}` to a template, then Draft/Send | `E-MAIL-TEMPLATE`, **nothing sent** |
| Approve a row, corrupt its email address, Send | Rejected for that row only — "is not a deliverable address" |
| Rename a column in the Applicants tab | `E-SHEET-SCHEMA` on the next read |
| Select two applicants for Send, one not `APPROVED` | Partial success — the eligible one sends, the other is reported rejected |

If any of these fails silently instead, that is a bug worth fixing before
going live.

---

## Capacity and cost

Everything is free-tier. The binding constraint is **tokens per day**, not
requests per minute.

A personalised draft costs roughly 1,800 tokens. On the Groq free tier that is
comfortably **50+ drafts per day**. Static templates (no `{{ai_body}}`) cost
nothing and are unlimited.

Gmail sends about 500/day on a consumer account; `send_daily_cap` in Config
defaults to 400 to stay under it.

---

## Documentation

Deployment, architecture, error codes, and the runbook are all above, in this
file. What's left as its own doc:

| | |
|---|---|
| **[LEARN.md](LEARN.md)** | A path from basic Python to working on this codebase, taught with real code from this repo. Predates this architecture — see the note at its top. |
| [PLAN.md](PLAN.md) | V1 and V2 plan, architecture decisions, open questions |
| [dashboard/README.md](dashboard/README.md) | Dashboard internals, the auth upgrade path, and the dashboard's own Gmail integration in full detail |
| [prompts/](prompts/) | Every prompt, versioned, with the reasoning |

---

## Known limitations

- **New applicants are added directly to the Applicants tab** (by hand or by
  pointing a Google Form at it), with `applicant_id`, `stage` = `NEW`, and
  `status` = `ok` set on the row. There is no automated intake step that
  validates, normalises or deduplicates a bare row — `npm run seed:demo`
  shows the shape a row needs.
- **Reply classification and follow-up flagging are manual.** Open the Inbox
  to read what a candidate said; nothing auto-classifies intent or flags a
  silent candidate for you.
- **Dashboard auth is a shared team password**, not per-user sign-in. It
  authenticates the team, so `approved_by` records `dashboard` rather than a
  person. Upgrade path in [dashboard/README.md](dashboard/README.md).
- **No resume parsing or match scoring** — that is V2.
