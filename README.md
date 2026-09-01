# HR Automation

Hiring outreach without the copy-paste. Candidates live in a Google Sheet; you
open one, say what the email should cover in plain English, and the model
writes it — their name, role and your branding filled in from the sheet. You
read it, you press Send.

Runs on free tiers, with no backend to host beyond the dashboard itself.

> **New to JavaScript?** [LEARN.md](LEARN.md) is a Python-to-JavaScript path
> built around this codebase. Start there rather than with a generic tutorial.
> It predates this architecture, so some file references are stale.

```
                    ┌───────────────┐
   you type ───────▶│ Google Sheet  │◀──── the app writes back
   name/email/role  │ (the database)│      drafts + send log
                    └───────┬───────┘
                            │
                    ┌───────▼───────┐      ┌──────┐
                    │   Dashboard   │─────▶│ Groq │  writes the message
                    │   (Next.js)   │      └──────┘
                    └───────┬───────┘
                            │
                    ┌───────▼───────┐
                    │  SMTP (Gmail) │─────▶ candidate's inbox
                    └───────────────┘             │
                                                  │
                    their reply ──────────────────┘
                    goes to your normal mailbox,
                    which you read like any other email
```

The dashboard is the only server-side piece. It reads and writes the sheet
directly, calls Groq to draft, and sends over SMTP — all in the same
request a person triggers by clicking a button. Nothing polls on a schedule and
nothing runs unattended.

**The app does not read anyone's mailbox.** It sends *from* a real Gmail account
over SMTP, so replies land in that account's inbox and you read them there like
any other email — and every send also appears in its Sent folder.

That is a deliberate trade. Sending this way needs no Google Cloud project, no
OAuth consent screen, no refresh token that expires after seven days, and no
domain of your own. The whole setup is: turn on 2-Step Verification, generate a
16-character App Password, paste it in.

---

## What it does

| | |
|---|---|
| **Write to one candidate** | Open them, type what the email should cover, click **Write with AI**. Their name, role and category come from the sheet — you never retype them. |
| **Bulk drafting** | Select several, click **Generate drafts**: picks the most specific matching template, then asks Groq to personalise it — but only for templates that opt in with `{{ai_body}}`. |
| **Review** | Every message is previewed and sent by a human. The model only ever fills the compose box. |
| **Sending** | Over SMTP, per-recipient isolated, with a daily cap and a dry-run mode that is **on by default**. |
| **Branding** | Every email — template or AI-written — is wrapped in the same letterhead shell automatically. |
| **Observability** | Every failure has a typed code, a plain-English message and a fix. The Console page is the whole debugging surface. |

---

## Requirements

| | |
|---|---|
| **Node** | 20 or newer |
| **Google account** | For the spreadsheet |
| **Groq API key** | free — [console.groq.com/keys](https://console.groq.com/keys) |
| **A Gmail account** | The one that sends, and receives replies. **Personal, not Workspace** — see below |
| **Nothing else** | No domain, no email provider account, no DNS records |
| **Render account** | free, for the dashboard |

---

## The spreadsheet

This is the part worth getting right, because the sheet *is* the database.

**Build it with `npm run bootstrap:sheets`, never by hand.** The dashboard
refuses to read a tab whose headers don't match the contract in
[lib/schema.js](lib/schema.js) — that refusal is `E-SHEET-SCHEMA`, and it fails
*every* read of that tab, not just the feature that needed the new column. The
script creates the four tabs with exact headers and seeds the Config defaults.
Re-running it only ever appends what's missing; it never deletes or reorders, so
it is always safe to re-run.

### Four tabs

| Tab | Who writes it | What it holds |
|---|---|---|
| **Applicants** | you, mostly | One row per candidate. The only tab you routinely type into. |
| **Templates** | you + the app | The reusable email shells. |
| **Config** | you, via the Settings page | Every switch and every piece of company branding. |
| **EmailLog** | the app only | One row per send attempt, real or dry-run. Your audit trail — never type here. |

### Applicants — the six columns you type

Columns are ordered so everything you type is on the left, before you have to
scroll:

| # | Column | You type? | Example | Notes |
|---|---|---|---|---|
| A | `applicant_id` | **yes** | `APP-1001` | Any unique string. A row with no id is invisible to the app. |
| B | `name` | **yes** | `Asha Menon` | `{{first_name}}` is the first word of this. |
| C | `email` | **yes** | `asha@example.com` | Where the email goes. |
| D | `job_role` | **yes** | `Frontend Engineer` | Free text. The role dropdown is built from whatever values appear in this column, so keep the spelling consistent. |
| E | `category` | optional | `Junior` | Seniority, or any bucket you like. Drives template matching. |
| F | `notes` | optional | `Referred by Meera, strong React portfolio` | Free text handed to the model as context. **The cheapest way to make a generated email specific** — one sentence here changes the whole message. |
| G | `stage` | **yes** | `NEW` | Where the row is in the pipeline. |

Everything from column H onward is written by the app — `template_id`,
`email_subject`, `email_html`, `sent_at`, `error_code`, `error_message`,
`created_at`, `updated_at`. **Don't type into those; you will be overwritten.**

The minimum viable row is `applicant_id`, `email`, `stage = NEW`. Name and role
are what make the emails good, and `notes` is what makes them specific.

### Templates

| Column | Meaning |
|---|---|
| `template_id` | Unique string, e.g. `TPL-DEFAULT` |
| `name` | What you see in the dropdown |
| `job_role`, `category` | Leave blank for a catch-all; fill in for a specialised one |
| `subject`, `html` | The email itself, with `{{merge_fields}}` |
| `source` | `seed` / `manual` / `ai` — informational |
| `is_active` | `TRUE` to make it selectable |
| `is_default` | `TRUE` on exactly one — the fallback |
| `attachment_url`, `attachment_name` | Optional file attached on every send |
| `updated_at` | Written by the app |

### Config

Five columns — `key`, `value`, `type`, `description`, `updated_at` — one row per
setting. Edit these on the **Settings** page rather than in the sheet, so the
types stay right. The ones that matter:

| Key | Default | What it does |
|---|---|---|
| `dry_run` | `true` | **The safety catch.** True = sends are logged, not delivered. |
| `toggle_send` | `false` | Master switch for sending. |
| `toggle_draft` | `true` | Master switch for AI drafting. |
| `send_daily_cap` | `400` | Kept under Gmail's ~500 recipients/day. |
| `company_email` | — | **Where candidates' replies go.** Set this to a mailbox you actually read. |
| `company_name`, `hr_name`, `hr_signature` | — | Merge fields. |
| `company_phone`, `company_incubator`, `company_logo_url` | — | The letterhead block. |
| `categories` | `Intern,Junior,Mid,Senior,Lead` | Suggestions for the category box. |

### Getting candidates in

There is no automated intake. Three options, in increasing order of effort:

1. **Type them in**, or use the dashboard's **+ New** button — it appends a
   properly shaped row for you.
2. **Paste in bulk** from a CSV into columns A–G.
3. **A Google Form on the same spreadsheet.** Form responses land in their own
   `Form Responses 1` tab, *not* in Applicants — the Form owns that tab's
   columns, so it can't be pointed at Applicants directly. Bridge it with a
   short Apps Script `onFormSubmit` trigger that appends a properly shaped row
   to Applicants.

### Duplicates

The sheet is typed into and pasted into by hand, so the same person arriving
twice is a matter of when, not if. The Inbox checks for two kinds on every
load, and **Run preflight** reports both:

| Repeated | Severity | Why |
|---|---|---|
| `applicant_id` | **blocks preflight** | Every action resolves a row with the *first* id that matches, so approving or emailing the second row silently acts on the first. You would see a success banner naming the right person while the wrong row moved. |
| `email` | warning | That person receives every email twice. Annoying and visible, but recoverable. |

Both appear as a banner above the list, with the **sheet row numbers** so you
can go and fix them, and a `duplicate` pill on each affected candidate. Two
people at the same company, or two people with the same name, are not treated
as duplicates — only the two fields the code actually keys on.

Editing an address in the app refuses to *create* a duplicate: `set-email`
returns `409` if another row already has it.

### Making it pleasant to work in

None of this is required — it's what stops a shared sheet rotting:

- **Freeze row 1** (View → Freeze → 1 row) on every tab.
- **Protect the header row** (right-click → Protect range) so nobody renames a
  column and takes the dashboard down with it. Highest-value item on this list.
- **Data validation** on `stage` (`NEW, DRAFTED, APPROVED, SENT, REPLIED,
  CLOSED, FAILED`) and `category`. Typos here are invisible until a draft
  silently doesn't happen.
- **Conditional formatting** on `stage`, so the pipeline reads at a glance.
- **Filter views** rather than filters — a filter view is per-person, so two
  people looking at once don't fight over the sort order.
- **Archive** `SENT` / `CLOSED` rows to another sheet once a quarter. Every page
  reads the whole tab, so a few thousand rows is where it starts feeling slow.
- **Version history** is your backup (File → Version history). Keep the
  service-account JSON somewhere safe and separate.

---

## Setup

### 1. Google: spreadsheet + service account

1. Create a spreadsheet. Copy its id from the URL — the part between `/d/` and
   `/edit`. That is `SHEET_ID`.
2. In [console.cloud.google.com](https://console.cloud.google.com), create a
   project, enable the **Google Sheets API**, then go to **IAM & Admin →
   Service Accounts → Create**. Give it any name; no roles needed.
3. On the service account, **Keys → Add key → JSON**. A file downloads. Its
   contents are `GOOGLE_SERVICE_ACCOUNT_JSON` — treat it like a password.
4. Open that JSON, copy the `client_email` value, then **Share** the spreadsheet
   with that address as **Editor**. Skipping this is the cause of
   `E-SHEET-PERM`.

No OAuth consent screen, no user login, no token expiry — a service account is
just a key that works until you revoke it.

### 2. Sending email (Gmail App Password)

No domain, no provider signup, nothing that expires:

1. On the Gmail account that should send — e.g. `3spacetechcorp@gmail.com` —
   turn on **2-Step Verification**
   ([myaccount.google.com/security](https://myaccount.google.com/security)).
   You cannot generate an App Password without it.
2. Go to
   [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords),
   name it `hr-dashboard`, and **Create**.
3. Google shows a 16-character password as four groups of four. Copy it and
   **remove the spaces** — it is shown once.
4. Set `MAIL_USER` to the Gmail address and `MAIL_PASSWORD` to that App
   Password.

```bash
MAIL_USER=3spacetechcorp@gmail.com
MAIL_PASSWORD=abcdefghijklmnop          # 16 chars, no spaces
MAIL_FROM=3Space Hiring <3spacetechcorp@gmail.com>   # optional display name
```

> **Personal Gmail only.** Google Workspace accounts cannot use App Passwords —
> Google requires OAuth 2.0 for those. If the sending account is on Workspace,
> either use a personal Gmail for sending, or point `MAIL_HOST`/`MAIL_PORT` at a
> different SMTP server.

Nothing here is Gmail-specific. `MAIL_HOST` and `MAIL_PORT` default to
`smtp.gmail.com:465` but point anywhere — a company mail server, a paid relay —
so outgrowing Gmail is an environment change, not a code change. Port 465 is
implicit TLS; 587 is STARTTLS.

Replies go to the sending account by default. Set `company_email` in **Settings**
only if they should land somewhere else — it becomes the `Reply-To`.

If `MAIL_USER` or `MAIL_PASSWORD` is missing while dry run is off, the app
**refuses every send** with `E-CONFIG-MISSING` rather than pretending. See
[Safety properties](#safety-properties).

### 3. Dashboard, locally

```bash
git clone <your-repo> && cd hr-automation
npm install
cd dashboard && npm install

cp .env.example .env.local
# fill in SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON, GROQ_API_KEY,
# DASHBOARD_PASSWORD, SESSION_SECRET (openssl rand -hex 32)
# leave MAIL_PASSWORD blank for now

cd .. && npm run bootstrap:sheets   # creates the four tabs
npm run seed:demo                   # optional: one template + 3 fake candidates

cd dashboard && npm run dev         # http://localhost:3000
```

**With `SHEET_ID` left blank the app runs on a built-in sample dataset** — fully
clickable, nothing persisted, nothing sent. Good for exploring before committing
to any Google setup.

### 4. Deploy to Render

The repo has a [render.yaml](render.yaml) blueprint, so this is mostly clicking.

1. Push to GitHub.
2. Render dashboard → **New → Blueprint** → pick the repo. Render reads
   `render.yaml`, creates one web service, and prompts for each secret.
3. Fill in: `DASHBOARD_PASSWORD`, `SESSION_SECRET`, `SHEET_ID`,
   `GOOGLE_SERVICE_ACCOUNT_JSON` (paste the whole JSON as-is — no quotes, no
   escaping), `GROQ_API_KEY`, `MAIL_USER`, `MAIL_PASSWORD`.
4. Deploy. The first build takes a few minutes.

Render sets `RENDER_EXTERNAL_URL` itself, which is how emails find the logo at
`/brand/logo.png`. You only need `COMPANY_LOGO_BASE_URL` if the logo should be
served from somewhere else.

**The free plan sleeps after 15 minutes idle**, so the first request after a
quiet spell takes ~30 seconds. Fine for an internal tool; upgrade if it annoys.

### 5. Verify, then go live

On the **Console** page, click **Run preflight**. Every check must pass.

Then, with `dry_run` still ON:

1. Add yourself as a candidate.
2. Draft and send. Nothing is delivered; a row appears in the Email Log marked
   *dry run*.

Then go live:

1. Settings → turn **Sending** on.
2. Settings → turn **dry run** off.
3. Run preflight again. The mailbox check **opens a real SMTP connection and
   authenticates**, so a green tick here means the credentials genuinely work —
   not merely that the variables are set. It is a *hard* failure once dry run
   is off.
4. Send one real email **to yourself**. If it arrives, every other send uses the
   identical code path.

---

## Everyday use

| Task | Where |
|---|---|
| Add candidates | The Applicants tab, or **+ New** in the dashboard |
| Fix a wrong email address | Open the candidate — the **Email** box in their header saves straight to the sheet |
| Pick up sheet edits | **⟳ Refresh from sheet** in the toolbar |
| Write to one person | Open them, type the brief, **Write with AI** |
| Bulk outreach | Select several → **Generate drafts** → **Approve** → **Send** |
| Change email wording | **Templates** page |
| Something is wrong | **Console** page → **Run preflight** |
| Turn Drafting/Sending off | **Settings** page. Takes effect on the next click, no redeploy. |

### Writing to one candidate

This is the main flow. Pick someone, then:

- **What should this email say?** — a plain-English brief. *"Invite her to a
  30-minute intro call next week, mention it's remote, ask for two time slots."*
  You never type her name or role; those come from the sheet, along with
  whatever is in her `notes` cell.
- **Base it on a template** (optional) — used as a style reference, not copied.
- **Write with AI** fills the subject and body, wrapped in the branded shell.
- Edit anything you like, preview, then **Send**.

**Use template as-is** skips the model entirely and just fills the merge fields
— free, instant, deterministic.

### Templates and the AI opt-in

A template is plain HTML with `{{merge_fields}}`:

```html
<p>Hi {{first_name}},</p>
{{ai_body}}
<p>{{hr_signature}}</p>
```

`{{ai_body}}` is the switch. **With it**, Groq writes 2–4 personalised
paragraphs per candidate when you click **Generate drafts**. **Without it**, the
template renders deterministically and costs zero tokens. Since the free-tier
token budget is the real constraint, this is how you decide where
personalisation is worth spending it.

Available fields: `first_name` `name` `email` `job_role` `category`
`applicant_id` `company_name` `hr_name` `hr_signature` `ai_body`
`company_email` `company_phone` `company_incubator` `company_logo_url`.

`notes` is not a merge field — it is never printed into an email. It is passed
to the model as background, so it shapes what gets written without appearing
verbatim.

An email with an unresolved `{{field}}` is **never sent** — it fails as
`E-MAIL-TEMPLATE` first. `Hi {{first_name}},` reaching a candidate is worse than
a visible error.

### Template matching

`selectTemplate()` scores every active template; the most specific one wins:

| Template has | Score |
|---|---|
| `job_role` matches the candidate | +4 |
| `job_role` set but **doesn't** match | −10 (disqualifying) |
| `category` matches | +2 |
| `category` set but doesn't match | −5 |
| `is_default = TRUE` | +1 |

Leave `job_role`/`category` blank for a catch-all, fill them in for a
specialised one, and keep exactly one default as the safety net. A candidate
whose role matches nothing gets the default plus a `W-TEMPLATE-DEFAULT` warning
in the result banner — that warning is your signal to write a role-specific
template.

### The branded skeleton

Every template — the seed default and every AI-generated one — is wrapped in the
same shell, following the company letterhead: monochrome, square-cornered,
hairline rules, wide-tracked caps. A black top strip, the logo with a contact
block opposite it (`{{company_email}}` / `{{company_phone}}` /
`{{company_incubator}}`), a rule, the message, then a small-caps footer.

It is table-based with inline styles, because that is the only thing every mail
client renders the same way. `<style>` blocks and `<svg>` are stripped by Gmail;
data-URI images are unreliable. The logo is therefore a real PNG served from the
deployment at `/brand/logo.png`.

The model never writes this shell — it writes the message body only, and
`renderSkeleton()` wraps it. That is why an AI-written email and a stored
template look identical in a candidate's inbox.

### Attaching a file to a template

On the **Templates** page, open a template's preview and paste a public URL
(e.g. a Drive "anyone with the link" share) plus a filename. The sheet stores
the *link*, not the bytes. It's fetched fresh at send time, so replacing the
linked file takes effect on the next send with no template edit. 15MB cap; an
unreachable link fails the send with `E-ATTACHMENT-FETCH` rather than sending
without it.

---

## Architecture

### Where logic lives

| File | Responsibility |
|---|---|
| [lib/schema.js](lib/schema.js) | **Single source of truth** for tabs, columns, the stage machine, Config defaults |
| [dashboard/lib/contract.ts](dashboard/lib/contract.ts) | Hand-mirror of the above (the dashboard deploys from `dashboard/` alone and can't import outside it). `tests/contract-parity.test.js` fails the build if they drift |
| [dashboard/lib/sheets.ts](dashboard/lib/sheets.ts) | All Sheets I/O, plus the demo dataset |
| [dashboard/lib/mailer.ts](dashboard/lib/mailer.ts) | All outbound email (SMTP via nodemailer, pooled) |
| [dashboard/lib/template.ts](dashboard/lib/template.ts) | Merge-field rendering, HTML validation, template selection, the branded skeleton |
| [dashboard/lib/draft.ts](dashboard/lib/draft.ts) | Batch selection, the draft prompt, the schema gate on model output |
| [dashboard/lib/groq.ts](dashboard/lib/groq.ts) | The only model provider |
| [dashboard/app/api/action/route.ts](dashboard/app/api/action/route.ts) | Every mutating action, and every safety gate |

**Google Sheets is the source of truth.** Not a cache, not a mirror. If the
dashboard is down, HR can still see every candidate and work by hand in the
sheet directly. That property is worth more than the performance a real database
would buy at this scale.

### The stage machine

```
NEW ──▶ DRAFTED ──▶ APPROVED ──▶ SENT ──▶ REPLIED ──▶ CLOSED
 │         │            │          │
 └─────────┴────────────┴──────────┴──▶ FAILED ──▶ (back to origin)
```

`DRAFTED → SENT` is illegal: approval is mandatory and enforced server-side, not
just hidden in the UI. `REPLIED` is set by hand — you move a row there after
reading the candidate's answer in your own inbox.

### Trust boundaries

- **The model never decides anything.** It writes prose. Approving and sending
  are human actions, enforced server-side.
- **Model output is validated before it can reach a candidate**: JSON shape,
  allowed tags, no `{{placeholders}}`, no `<script>`/`<iframe>`, length cap.
- **Merge rendering is fail-closed.** An unresolved field blocks the send.
- **Secrets live only in the environment.** `.env.local` is gitignored; only
  `.env.example` is tracked.
- **`/brand/*` is deliberately public** so email clients can load the logo. Put
  nothing sensitive there.

### What is deliberately not automated

- **Approval.** A human reads every email before it goes.
- **Intake.** No scraper, no inbox parser. Rows arrive because someone put them
  there.
- **Reading replies.** They land in a real mailbox and a human reads them.
- **Anything on a timer.** Every action starts with a click.

---

## Safety properties

These are enforced in code, not just intended. They are the invariants worth
protecting when changing anything:

1. **Nothing sends without a human click.** The model only fills the compose box.
2. **`DRAFTED → SENT` is impossible.** Approval is enforced server-side.
3. **Dry run ships ON and `toggle_send` ships OFF.** A fresh deployment cannot
   email anyone by accident.
4. **A broken mailer stops the line; it never fakes a send.** Dry run off with no
   `MAIL_PASSWORD` returns `503 E-CONFIG-MISSING` *before* any row or log line
   is written, shows a red *Sending is broken* banner, and fails preflight. The
   one thing this system must never do is report an email as sent that no
   candidate will ever receive.
5. **EmailLog is written before the pipeline state.** A send that isn't in the
   log is a send somebody repeats.
6. **One failed recipient never aborts a batch** — and never leaves that row
   looking sent. It stays `APPROVED` and retryable, with `result: failed` logged.
7. **An unresolved `{{field}}` blocks the send.**
8. **Already-sent rows are refused.** `sent_at` is the duplicate guard.
9. **Bulk send names every recipient** in the request — there is no one-click
   "email everyone".
10. **The daily cap is counted from EmailLog, not an in-memory counter**, so it
    survives restarts.

---

## Error codes

Every failure carries a code, a plain-English message and a fix. They're defined
where they're thrown: `SheetsError` in `dashboard/lib/sheets.ts`, `GroqError` in
`dashboard/lib/groq.ts`, `MailerError` in `dashboard/lib/mailer.ts`,
`TemplateError` in `dashboard/lib/template.ts`.

```
E-MAIL-TEMPLATE
│ │    └── the specific problem
│ └─────── the subsystem
└───────── E = error, W = warning (recorded, never fatal)
```

There is no automatic retry or failover layer — a failed action reports its code
and stops; the human who clicked decides whether to try again.

### `E-SHEET-*` — Google Sheets

| Code | Cause | Fix |
|---|---|---|
| `E-SHEET-PERM` | No access to the spreadsheet, or it doesn't exist | Share it with the service-account email as **Editor**. The most common setup mistake. |
| `E-SHEET-SCHEMA` | A column is missing | `npm run bootstrap:sheets`. It appends missing columns without touching data. |
| `E-SHEET-429` | Rate limit | Wait and refresh. Usually several tabs open at once. |

### `E-CONFIG-*` — setup

| Code | Cause | Fix |
|---|---|---|
| `E-CONFIG-MISSING` | A required environment variable is absent | Run **Console → Run preflight** for the full list. On a send it means dry run is off with no mailer configured — **nothing was sent and nothing was logged as sent**. |
| `E-CONFIG-CRED` | `GOOGLE_SERVICE_ACCOUNT_JSON` isn't valid JSON | Re-paste the whole key file. |
| `E-CONFIG` | A master switch is off | Turn it on in Settings. |

### `E-MAIL-*` — sending

| Code | Cause | Fix |
|---|---|---|
| `E-MAIL-AUTH` | SMTP rejected the login (`535`) | You used the Google account password instead of an App Password, 2-Step Verification is off, or the 16 characters were pasted with spaces. **The most common first-send failure.** |
| `E-MAIL-429` | The server is throttling | Gmail's daily quota — about 500 recipients over a rolling 24 hours on a personal account. It resumes on its own. |
| `E-MAIL-REJECTED` | The recipient was rejected (`550`/`553`) | A mistyped or dead address. Fix it in the candidate's **Email** box. |
| `E-MAIL-NETWORK` | Could not reach the mail server | Check `MAIL_HOST`/`MAIL_PORT`. 465 needs implicit TLS, 587 needs STARTTLS — a mismatch hangs rather than erroring cleanly. Nothing was sent. |
| `E-MAIL-TEMPLATE` | Unresolved `{{field}}`, invalid HTML, or an empty subject | **Nothing was sent.** Fix the template or supply the missing value. |
| `E-ATTACHMENT-FETCH` | A template's `attachment_url` was unreachable | Confirm the link is shared "Anyone with the link" and loads without signing in. |

### `E-LLM-*` — the model layer (Groq)

| Code | Cause | Fix |
|---|---|---|
| `E-LLM-HTTP` | Groq returned a non-2xx response | Check `GROQ_API_KEY` and that `GROQ_MODEL` is still a current model id. |
| `E-LLM-JSON` | Response wasn't parseable JSON, or failed the merge/HTML gate | Usually transient — try again. |
| `E-LLM-SCHEMA` | Parsed JSON failed the draft schema check | Try again; if it recurs for the same person, an unusual character in their name or role may be confusing the prompt. |
| `E-LLM-EMPTY` | Groq returned nothing usable | Try again, or write it manually. |

### Request-level

| Code | Cause |
|---|---|
| `E-AUTH` | Session expired — sign in again. |
| `E-BADREQ` | Missing a required field (no applicant selected, no brief and no template, ...). |
| `E-STAGE` | A bulk action was attempted on rows not in a legal stage for it. |
| `E-QUOTA` | The day's `send_daily_cap` is used up. Resumes tomorrow, or raise it in Settings — Gmail itself stops around 500 recipients/day. |
| `E-VALIDATION` | Attachments exceed the size cap, or an edited email address is malformed or already on another row. |
| `E-NOTFOUND` | The applicant/template/config key named in the request doesn't exist. |
| `E-UNKNOWN` | An unclassified failure. Check the Render logs for the stack trace. Seeing it repeatedly means a failure mode worth its own typed code. |

### `W-*` — warnings

| Code | Means |
|---|---|
| `W-TEMPLATE-DEFAULT` | No role-specific template matched, so the default was used — a more generic email than intended. |

---

## Runbook

### Emails are not sending

In order:

1. **Console → Run preflight.** It names the broken credential.
2. **Settings → is Sending on?** It ships off.
3. **Settings → is dry run off?** Dry run logs without delivering, by design.
4. **Red banner saying "Sending is broken"?** Dry run is off but the mailer
   isn't configured. Set `MAIL_USER` and `MAIL_PASSWORD`. Nothing has been
   falsely recorded as sent.
5. **`E-MAIL-AUTH`?** Almost always the App Password: either 2-Step
   Verification is off, you used the account password, or the 16 characters
   were pasted with Google's display spaces still in them.
6. **Rows stuck at `APPROVED` with errors in the Email Log?** Read the
   `error_message` column — that's the reason, per recipient.

### Applicants are not appearing

A row needs an `applicant_id` and at least one non-empty cell. Check it isn't
being hidden by the role/stage/category filter dropdowns.

### Draft is not generating

Check `GROQ_API_KEY` in preflight; check **Drafting** is on in Settings; check
the row's stage is `NEW`, `DRAFTED` or `FAILED`.

### "Write with AI" is greyed out

It needs either a brief in the instructions box or a selected template — the
same check the server enforces. There is nothing for the model to work from
otherwise.

### The dashboard shows an error banner

`E-SHEET-SCHEMA` means the sheet drifted from the contract — run
`npm run bootstrap:sheets`. It is the fix for *every* schema error, and it is
always safe to re-run.

### Recovering a stuck row

Edit the sheet directly. Set `stage` back to `NEW` and clear `email_subject`,
`email_html`, `sent_at`, `error_code`, `error_message`. The dashboard picks it up
on the next read.

### Changing the AI's behaviour

The prompts are inline in
[dashboard/app/api/action/route.ts](dashboard/app/api/action/route.ts) (the
one-off composer and template generation) and
[dashboard/lib/draft.ts](dashboard/lib/draft.ts) (bulk drafting). Change the
wording, redeploy. The schema gate that validates the output is
`checkDraftSchema()` — tighten that, not the prompt, if the model keeps emitting
something it shouldn't.

### Rotating a secret

Update it in Render's environment, redeploy, then revoke the old one. For the
Google key: create a new service-account key, update the env var, redeploy,
*then* delete the old key.

---

## Costs

| | |
|---|---|
| Google Sheets | free |
| Groq | free tier; only `{{ai_body}}` templates and **Write with AI** spend tokens |
| Gmail SMTP | free: ~500 recipients/day, rolling 24h |
| Render | free (sleeps when idle) |
| **Total** | **₹0/month** at this volume |

The binding constraint is Gmail's ~500 recipients a day. `send_daily_cap`
defaults to 400, leaving headroom for the mail you send by hand from the same
account.

---

## Development

```bash
npm test                                    # contract + schema tests
cd dashboard && npx tsc --noEmit            # typecheck
cd dashboard && npm run build               # production build
npm run check:sheets                        # report sheet drift, change nothing
```

The tests are the guardrail that matters: `contract-parity.test.js` and
`write-columns.test.js` catch the column drift that would otherwise surface as
`E-SHEET-SCHEMA` in production, mid-send.

---

## Known limitations

- **Replies are not shown in the app.** They arrive in whatever mailbox
  `company_email` points at. This is the deliberate trade described at the top.
- **No automated intake.** Rows arrive because someone put them there.
- **One shared password** rather than per-user sign-in.
- **No reply classification.** The `REPLIED` stage is set by hand.
- **Free-tier Render sleeps**, so the first request after idle is slow.
- **Every page reads whole tabs.** A few thousand rows is where it slows down;
  archive `SENT`/`CLOSED` rows periodically.
