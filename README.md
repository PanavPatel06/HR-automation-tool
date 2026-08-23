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

Full detail with screenshots-worth of specifics is in
**[docs/deployment.md](docs/deployment.md)**; this is the skeleton.

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

## Deploying to production

Nothing above was "local dev" versus "production" — the same steps *are* the
deployment. Two pieces to put somewhere permanent, neither of which needs a
server you manage:

| Piece | Where it runs | Cost | What "deployed" means here |
|---|---|---|---|
| **Google Sheet** | Google's servers | Free | Nothing to do — it's already live the moment you created it in step 2. |
| **Dashboard** | [Vercel](https://vercel.com) | Free (Hobby tier) | Import the repo, set **Root Directory = `dashboard`**, add the environment variables from `dashboard/.env.example` in **Project Settings → Environment Variables**, deploy. |

Concretely, going from "runs on my laptop" to "a real HR person can use it
from a URL": push this repo to GitHub (or wherever), then in Vercel: **New
Project** → import it → set **Root Directory** to `dashboard` → add every
variable from `dashboard/.env.example` (same values as your local
`.env.local`) → **Deploy**. Then re-run **Console → Run preflight** against
the deployed dashboard — it checks the same things it did locally, now
against the real URL.

No separate database, container registry, CDN config, or always-on host to
set up — Sheets is the database and Vercel handles the dashboard's
build/CDN/TLS. Full step-by-step with every screen you'll see:
**[docs/deployment.md](docs/deployment.md)**.

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
`company_name` `hr_name` `hr_signature` `ai_body`.

An email with an unresolved `{{field}}` is **never sent** — it fails as
`E-MAIL-TEMPLATE` first. `Hi {{first_name}},` reaching a candidate is worse than
a visible error.

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

## How it is put together

```
lib/schema.js       the sheet contract: tab names, columns, the stage machine
scripts/             sheet bootstrap, Gmail OAuth setup
dashboard/           the whole app — Next.js, deploys to Vercel
  app/api/action/     every mutating action: draft, send, approve, ...
  lib/                Sheets, Groq, Gmail, template rendering, draft logic
tests/               library tests, no network or credentials required
docs/                deployment, error codes, runbook, architecture
prompts/             every prompt, versioned
```

`lib/schema.js` is the single source of truth for the sheet's tab names,
columns and stage machine. The dashboard deploys from `dashboard/` alone and
cannot import outside it, so `dashboard/lib/contract.ts` mirrors it by hand;
`tests/contract-parity.test.js` fails the build if the two ever drift apart.

```bash
npm test                    # library tests
cd dashboard && npm run typecheck && npm run build   # the app itself
```

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

## When something breaks

Every failure carries a typed code and a plain-English message with a fix.
Start at the **Console** page.

| Code | Means | Fix |
|---|---|---|
| `E-SHEET-PERM` | Service account cannot read the sheet | Share the spreadsheet with it as Editor |
| `E-SHEET-SCHEMA` | A column is missing | `npm run bootstrap:sheets` |
| `E-INTAKE-ROLE` | `job_role` is not in the JobRoles tab | Add the role or fix the spelling |
| `E-MAIL-TEMPLATE` | Unresolved `{{field}}` | Fix the template; nothing was sent |
| `E-MAIL-NODRAFT` | Send attempted without an approved draft | Generate and approve first |
| `E-LLM-AUTH` | Groq API key rejected | Check `GROQ_API_KEY` in the dashboard environment |

Full catalogue: **[docs/error-codes.md](docs/error-codes.md)**.
Symptom-first troubleshooting: **[docs/runbook.md](docs/runbook.md)**.

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

| | |
|---|---|
| **[LEARN.md](LEARN.md)** | A path from basic Python to working on this codebase, taught with real code from this repo. Predates this architecture — see the note at its top. |
| [PLAN.md](PLAN.md) | V1 and V2 plan, architecture decisions, open questions |
| [docs/deployment.md](docs/deployment.md) | Full setup, step by step |
| [docs/architecture.md](docs/architecture.md) | How the pieces fit and why |
| [docs/error-codes.md](docs/error-codes.md) | Every code, what causes it, how to fix it |
| [docs/runbook.md](docs/runbook.md) | "X is broken → do Y" |
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
