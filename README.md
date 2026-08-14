# HR Automation — V1

Hiring outreach, automated end to end: applicants land in a Google Sheet, the
system drafts a role-appropriate email for each one, HR reviews and sends from a
dashboard, and replies come back classified.

Runs entirely on free tiers. **Status: V1 complete.** V2 (resume parsing and
match scoring) is planned but not built — see [PLAN.md](PLAN.md).

> **New to JavaScript?** [LEARN.md](LEARN.md) is a Python-to-JavaScript path
> built entirely around this codebase, with a 12-step exercise ladder and a
> re-cut V2 plan. Start there rather than with a generic tutorial.

```
Google Form ─┐
             ├─▶ Google Sheets ◀──▶ n8n ◀──▶ Groq / Gemini
Manual entry ─┘   (source of truth)   │
                        ▲             └──▶ Gmail ──▶ candidate
                        │                              │
                  Next.js dashboard ◀──────────────────┘
                   (review + trigger)      replies, classified
```

---

## What it does

| | |
|---|---|
| **Intake** | Polls the Applicants tab every 2 minutes. Validates, normalises, deduplicates. A bad row is *blocked with a reason*, never dropped. |
| **Drafting** | Picks the most specific matching template, then asks Groq to personalise it — but only for templates that opt in with `{{ai_body}}`. Gemini is the automatic fallback. |
| **Review** | Every draft is previewed and approved by a human. Nothing sends without approval. |
| **Sending** | Sends via Gmail, per-recipient isolated, with a daily cap and a dry-run mode that is **on by default**. |
| **Replies** | Polls the mailbox, matches by thread id, classifies intent. Low confidence escalates to a human instead of deciding. |
| **Observability** | Every failure has a typed code, a plain-English message, a fix, and a correlation id. The Console page is the whole debugging surface. |

---

## Requirements

| | |
|---|---|
| **Node** | 20 or newer (developed on 25) |
| **A server for n8n** | Any Docker host. [Oracle Cloud Always Free](docs/deployment.md#1-a-server-for-n8n) is the only genuinely free always-on option. |
| **Google account** | For the spreadsheet and the sending mailbox |
| **Groq API key** | free — [console.groq.com/keys](https://console.groq.com/keys) |
| **Gemini API key** | free, strongly recommended — without it there is no failover |
| **Vercel account** | free, for the dashboard |

Docker is needed **only on the n8n host**, not on your laptop.

---

## Quick start

The whole setup is roughly 40 minutes. Full detail with screenshots-worth of
specifics is in **[docs/deployment.md](docs/deployment.md)**; this is the
skeleton.

### 1. Get the code

```bash
git clone <your-repo-url> hr-automation
cd hr-automation
npm install
npm test          # 105 tests, no credentials needed
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

### 3. n8n

```bash
scp -r n8n/ user@your-server:~/hr-n8n/       # or git clone on the server
ssh user@your-server
cd ~/hr-n8n
cp .env.example .env && $EDITOR .env         # see the file for what each value is
docker compose up -d
```

Then in the n8n editor at `https://your-host`:

1. **Credentials** → add *Google Service Account* named `HR Sheets Service Account`
   (paste the same JSON key) and *Gmail OAuth2* named `HR Gmail`.
2. **Import** every file in `n8n/workflows/`.
3. On each workflow: bind the credential on each Google/Gmail node, set
   **Settings → Error Workflow → WF-90 Error Handler**, then activate.
   **Leave WF-03 Send inactive for now.**
4. Run **WF-00 Preflight** manually. Fix anything it reports before continuing.

### 4. Dashboard

```bash
cd dashboard
cp .env.example .env.local && $EDITOR .env.local
npm install && npm run dev        # http://localhost:3000
```

Deploy to Vercel with **Root Directory = `dashboard`**, and set the same four
environment variables there.

`N8N_WEBHOOK_SECRET` must be **byte-identical** between `n8n/.env` and the
dashboard, or every action is rejected with `E-CONFIG-CRED`.

### 5. First run

1. Open the dashboard → **Console** → **Run preflight**. Everything should be green.
2. Add a row to the Applicants tab: `name`, `email`, `job_role` (must match a row
   in JobRoles). Within 2 minutes it appears as **NEW**.
3. Select it → **Generate drafts** → **Preview** → **Approve**.
4. **Settings** → turn on *Sending (WF-03)*. Leave **dry run ON**.
5. Select the row → **Dry-run send**. Check the EmailLog tab: a `dry-run` entry,
   no email sent.
6. When the dry run looks right: **Settings** → **Go live**, then send for real.

---

## Everyday use

| Task | Where |
|---|---|
| Add applicants | The Applicants tab, or a Google Form pointed at it. Only `name`, `email`, `job_role` are required. |
| Change email wording | **Templates** page — upload HTML or generate one. |
| Approve and send | **Applicants** page. |
| See what candidates said | **Replies** page. Uncertain ones sort first. |
| Something is wrong | **Console** page. Start with **Run preflight**. |
| Turn an automation off | **Settings** page. Takes effect on the next run, no redeploy. |

### Templates and the AI opt-in

A template is plain HTML with `{{merge_fields}}`:

```html
<p>Hi {{first_name}},</p>
{{ai_body}}
<p>{{hr_signature}}</p>
```

`{{ai_body}}` is the switch. **With it**, Groq writes 2–4 personalised
paragraphs for each candidate. **Without it**, the template renders
deterministically and costs zero tokens. Since the free-tier daily token budget
is the real constraint, this is how you decide where personalisation is worth
spending it.

Available fields: `first_name` `name` `email` `job_role` `category`
`company_name` `hr_name` `hr_signature` `ai_body`.

An email with an unresolved `{{field}}` is **never sent** — it fails as
`E-MAIL-TEMPLATE` first. `Hi {{first_name}},` reaching a candidate is worse than
a visible error.

---

## How it is put together

```
n8n/src/lib/        tested engine: validation, templating, AI router, quotas
n8n/src/nodes/      Code-node bodies (thin wrappers around the engine)
n8n/workflows/      GENERATED workflow JSON — never edit by hand
scripts/            workflow builder, sheet bootstrap
dashboard/          Next.js app (Vercel)
tests/              105 tests, no network or credentials required
docs/               deployment, error codes, runbook, architecture
prompts/            every prompt, versioned
```

### Workflow logic is real, tested code

n8n Code nodes cannot `require` local files, which normally forces workflow
logic to live as untestable strings inside JSON. Here it lives in ordinary
modules that `tests/` exercises directly, and `npm run build:workflows` inlines
them into the node bodies.

`tests/bundle.test.js` then executes the *generated* bodies against fake n8n
globals — so the bundling, the `$('Node')` reads, and the branch wiring are all
covered too, not just the pure functions.

**Never edit a Code node inside the n8n editor.** Edit the source, run
`npm run build:workflows`, re-import.

```bash
npm test                    # library + generated-node tests
npm run check:workflows     # graph validation + staleness check
npm run verify              # both — run this before importing anything
```

`check:workflows` fails if committed JSON is stale, if a Code node reads a
`$('Node')` that does not exist or is not upstream of it, if a node is
unreachable from a trigger, if a webhook lacks signature verification, or if a
generated body does not parse.

---

## Safety properties

These are enforced in code and covered by tests, not just intended:

- **Nothing sends without human approval.** `DRAFTED → SENT` is not a legal transition; approval is a separate, human-only step.
- **Dry run ships ON**, and `toggle_send` ships OFF.
- **Bulk send names every recipient** in a confirmation before it happens. There is no one-click "email everyone".
- **Unresolved merge fields block the send.**
- **One bad applicant never aborts a batch** — item-level isolation everywhere.
- **A model never decides an outcome.** It drafts and it classifies; approving, rejecting and sending are human actions.
- **Exhausted quota parks, it does not fail.** Rows stay retryable and resume at the window reset.
- **Candidate prose never reaches a log line** — `safeJson` redacts it; only ids are logged.
- **Degradation is never silent.** A Groq→Gemini failover records `W-AI-FAILOVER` on the row.

---

## When something breaks

Every failure carries a typed code. Start at the **Console** page — code,
message, and fix are all inline.

| Code | Means | Fix |
|---|---|---|
| `E-SHEET-PERM` | Service account cannot read the sheet | Share the spreadsheet with it as Editor |
| `E-SHEET-SCHEMA` | A column is missing | `npm run bootstrap:sheets` |
| `E-CONFIG-CRED` | n8n rejected the dashboard's signature | `N8N_WEBHOOK_SECRET` differs between the two, or clocks are >5 min apart |
| `E-INTAKE-ROLE` | `job_role` is not in the JobRoles tab | Add the role or fix the spelling |
| `E-MAIL-TEMPLATE` | Unresolved `{{field}}` | Fix the template; nothing was sent |
| `E-MAIL-NODRAFT` | Send attempted without an approved draft | Generate and approve first |
| `E-QUOTA-TPD` | Daily token budget spent | Not an error — work resumes at reset. Add `GEMINI_API_KEY` to raise the ceiling |
| `E-LLM-AUTH` | API key rejected | Check `GROQ_API_KEY` in `n8n/.env` |

Full catalogue: **[docs/error-codes.md](docs/error-codes.md)**.
Symptom-first troubleshooting: **[docs/runbook.md](docs/runbook.md)**.

**"Nothing is happening at all"** is the one failure that produces no errors —
because nothing runs, so nothing fails. WF-91 writes a heartbeat every 10
minutes and the dashboard shows a red banner when it goes stale.

---

## Capacity and cost

Everything is free-tier. The binding constraint is **tokens per day**, not
requests per minute.

A personalised draft costs roughly 1,800 tokens. On the Groq free tier that is
comfortably **50+ drafts per day**, and Gemini's separate quota pool
roughly doubles the ceiling. Static templates (no `{{ai_body}}`) cost nothing
and are unlimited.

Gmail sends about 500/day on a consumer account; `send_daily_cap` in Config
defaults to 400 to stay under it.

Live usage is on the **Console** page. The published free-tier limits change
without notice, so they live in `n8n/src/lib/ai-router.js` as overridable
defaults and the router self-corrects from Groq's `x-ratelimit-*` response
headers. Verify them in the consoles when you set up.

---

## Documentation

| | |
|---|---|
| **[LEARN.md](LEARN.md)** | **Start here if you are new to JavaScript.** A path from basic Python to working on this codebase, taught with real code from this repo |
| [PLAN.md](PLAN.md) | V1 and V2 plan, architecture decisions, open questions |
| [docs/deployment.md](docs/deployment.md) | Full setup, step by step |
| [docs/architecture.md](docs/architecture.md) | How the pieces fit and why |
| [docs/error-codes.md](docs/error-codes.md) | Every code, what causes it, how to fix it |
| [docs/runbook.md](docs/runbook.md) | "X is broken → do Y" |
| [n8n/README.md](n8n/README.md) | Editing and re-importing workflows |
| [dashboard/README.md](dashboard/README.md) | Dashboard internals and the auth upgrade path |
| [prompts/](prompts/) | Every prompt, versioned, with the reasoning |

---

## Known limitations

- **The n8n workflows have not been executed against a live n8n instance.** The
  library and the generated node bodies are covered by 105 tests, and the graphs
  are structurally validated, but node parameter shapes (Sheets/Gmail options)
  are written against the documented schema and want a real smoke test. Run
  WF-00 Preflight and a dry run first — that is what they are for.
- **Dashboard auth is a shared team password**, not per-user sign-in. It
  authenticates the team, so `approved_by` records `dashboard` rather than a
  person. Upgrade path in [dashboard/README.md](dashboard/README.md).
- **Follow-ups are flagged, never sent.** Deliberate for V1.
- **Free-tier rate limits are placeholders** until verified in the consoles.
- **No resume parsing or match scoring** — that is V2.
