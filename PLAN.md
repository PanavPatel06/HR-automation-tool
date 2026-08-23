# HR Automation — Build Plan (V1 & V2)

> Derived from [GOAL.md](GOAL.md). This is the working plan; it is expected to be
> edited as decisions land. Anything marked **[DECIDE]** needs a human answer
> before the milestone that depends on it starts.

> **2026-08-23 — n8n removed.** §1, §3, §4, §5 and §7-8 below describe the
> original design, where a separate n8n instance held every side effect and
> the dashboard only sent it signed webhooks. That instance was never
> actually run in production, and every side effect it owned (drafting,
> sending, template generation, preflight) has since been reimplemented as a
> direct, in-process dashboard action — see [docs/architecture.md](docs/architecture.md)
> for the current design. Sections below are kept as the historical record
> and as a source of ideas for V2 (the scoring/queue/quota design in particular
> still applies conceptually — it would just run as dashboard actions instead
> of n8n workflows), but treat any mention of n8n, webhooks, or a workflow
> engine as **not what's currently deployed.**

---

## Status — 2026-08-23

**V1 is built and running without n8n.** Drafting, sending, template
generation and preflight all run in-process in the dashboard (Groq + Gmail
called directly). See [README.md](README.md) to run it.

| Milestone | State | Notes |
|---|---|---|
| M0 Foundations | **built** | `bootstrap-sheets.mjs`, README, deploys to Render or Vercel |
| M1 Intake | **manual** | No automated validation/normalisation step — rows are added to the sheet already in shape. See [Known limitations](README.md#known-limitations). |
| M2 Templates + drafting | **built** | Direct Groq call from the dashboard's Draft action, no failover provider |
| M3 Sending | **built** | Direct Gmail call from the dashboard's Send action, dry run, daily cap, per-recipient isolation |
| M4 Replies | **manual** | Inbox shows a candidate's thread on demand; no automated classification |
| M5 Console + hardening | **built** | Preflight, error catalogue, dashboard Console |

**Superseded:** the "needs a live n8n instance" gap noted in the previous
status update no longer applies — there is no n8n instance to run. The
dashboard's own action routes are what execute, and they're exercised
directly (see the Quick start in [README.md](README.md)).

### Who is building V2

V2 is being built by a developer coming from basic Python, learning JavaScript
on this codebase rather than rewriting it. That changes the sequencing, not the
design: **[LEARN.md](LEARN.md)** re-cuts §6's milestones into learning-sized
pieces (V2-A … V2-G), each naming its prerequisite.

The dependency that matters: **V2-D onwards requires being comfortable with
async/await**, and V2-F (the queue runner) is the hardest file in the project.
Neither should be started early — V2-A and V2-B are deliberately placed first
because they need no new language concepts.

**Decisions taken while building** (see §11 for the rest):

| # | Decision | Rationale |
|---|---|---|
| 1 | Oracle Cloud Always Free, Render documented as fallback | Only genuinely free always-on option; Render's sleep breaks scheduled triggers |
| 3 | Gmail via OAuth on the HR mailbox | Replies land in the same inbox, so reply tracking is free |
| — | **Dashboard auth is a shared team password, not per-user Google sign-in** | *Deviation from §5.* Zero dependencies and no OAuth app to register, so the dashboard runs immediately. Cost: `approved_by` records `dashboard`, not a person. Upgrade path documented in [dashboard/README.md](dashboard/README.md). |
| — | Templates opt into AI with `{{ai_body}}` | Not in the original plan. Makes the token cost of personalisation an explicit per-template choice, which matters because TPD is the binding constraint (§7) |
| — | **n8n removed; every side effect moved in-process into the dashboard** | *Deviation from §1/§3.* Every action in V1 is triggered by a person clicking a button — there's no scheduled or unattended work — so the split between "trigger" (dashboard) and "does the side effect" (a separately hosted workflow engine, connected by a signed webhook) was pure overhead with nothing running on the other end of it. Cost: no automated intake normalisation, no scheduled reply polling, no Groq→Gemini failover, no persisted quota ledger — all four are documented in [Known limitations](README.md#known-limitations) and can come back as explicit dashboard actions if volume ever demands it. |

---

## §0 — Principles (apply to both versions)

| # | Principle | What it means in practice |
|---|-----------|---------------------------|
| 1 | **Free to host, permanently** | No credit-card-required tiers. Every component below has a truly-free plan (§3). |
| 2 | **Failures are loud and specific** | Every failure produces a typed error code, a human message, and a correlation ID. No silent `continueOnFail`. (§8) |
| 3 | **Sheets is the source of truth** | The dashboard is a *view + trigger* layer. If the dashboard dies, HR can still work in Google Sheets. |
| 4 | **The LLM is optional, never load-bearing** | If Groq and Gemini are both down, the pipeline pauses cleanly — it does not corrupt rows or send half-written emails. |
| 5 | **Quota-aware by design** | Every LLM call goes through one rate-limited queue with a live token budget and an ETA. Never fire-and-hope. (§7) |
| 6 | **Docs live in the repo, in markdown** | README stays runnable-from-zero; every non-n8n component is specced in `docs/*.md`. |
| 7 | **V1 ships before V2 starts** | V2 is strictly additive — it adds a parse + score stage *in front of* the V1 outreach engine and reuses everything else. |

---

## §1 — Architecture

Both versions share one spine. V2 inserts two stages before drafting.

```
                                                    ┌──────────────────────┐
  Google Form ──┐                                   │  Groq  (primary)     │
                ├──▶  Google Sheets  ◀──────┐       │  Gemini (fallback)   │
  Manual entry ─┘     (source of truth)     │       └──────────┬───────────┘
                             ▲              │                  │
                             │              │            ┌─────┴─────┐
                             │              │            │ AI Router │  ← rate limiter,
                             │              │            │  + Queue  │    budget, ETA
                             │              │            └─────┬─────┘
                       ┌─────┴──────────────┴────────────────  │  ──────┐
                       │              n8n  (workflow engine)   │        │
                       │  WF-01 Intake        WF-10 Parse ─────┘        │
                       │  WF-02 Draft         WF-11 Score              │
                       │  WF-03 Send          WF-12 Queue runner       │
                       │  WF-04 Replies       WF-90 Error handler      │
                       └───────▲───────────────────────┬───────────────┘
                               │ webhook (HMAC-signed) │ SMTP / Gmail API
                               │                       ▼
                    ┌──────────┴──────────┐      HR ↔ Candidate email
                    │  Dashboard (Next.js)│
                    │  Vercel free tier   │
                    └─────────────────────┘
```

**Control flow.** The dashboard never talks to Groq, Gmail, or the candidate. It
calls signed n8n webhooks and reads Google Sheets. n8n owns all side effects.
This keeps secrets in one place and makes every action auditable in one log.

**Read path.** Dashboard → Google Sheets API (service account, read-only scope for
display) → render. Polled every 15 s while a tab is focused; no websockets needed.

**Write path.** Dashboard → `POST /api/action/*` (Next.js route) → HMAC-signs the
payload → n8n webhook → n8n does the work → n8n writes back to Sheets → next poll
shows it.

---

## §2 — Data model (Google Sheets)

One spreadsheet, multiple tabs. Column names are stable contracts — n8n and the
dashboard both key off them, so renaming a column is a breaking change.

### Tab: `Applicants` (V1 + V2)

| Column | Type | Written by | Notes |
|---|---|---|---|
| `applicant_id` | string | Intake | `APP-{yyyymmdd}-{6char}`. Immutable primary key. |
| `created_at` | ISO8601 | Intake | UTC always; dashboard renders local. |
| `name` | string | Form/HR | |
| `email` | string | Form/HR | Validated + lowercased at intake. |
| `phone` | string | Form/HR | Optional. |
| `job_role` | enum | Form/HR | Must match a row in `JobRoles`. |
| `category` | enum | Form/HR | e.g. Intern / Junior / Senior. **[DECIDE]** final list. |
| `resume_link` | url | Form/HR | Drive link or external URL. |
| `resume_file_id` | string | Intake | Resolved Drive file ID, if resolvable. |
| `source` | enum | Intake | `form` \| `manual` \| `import`. |
| `stage` | enum | pipeline | See state machine below. |
| `status` | enum | pipeline | `ok` \| `pending` \| `failed` \| `blocked`. |
| `email_subject` | string | WF-02 | Generated. |
| `email_html` | string | WF-02 | Generated, HTML. Truncated in sheet if >45k chars; full copy in `Drafts`. |
| `email_status` | enum | WF-03 | `none` \| `queued` \| `sent` \| `bounced` \| `failed`. |
| `sent_at` | ISO8601 | WF-03 | |
| `thread_id` | string | WF-03 | Gmail thread ID — the join key for replies. |
| `reply_state` | enum | WF-04 | `none` \| `replied` \| `interested` \| `declined` \| `needs_human`. |
| `error_code` | string | any | Typed code from §8. Empty when healthy. |
| `error_message` | string | any | Human-readable, one line. |
| `correlation_id` | string | any | Ties the row to a run in `RunLog`. |
| `updated_at` | ISO8601 | any | |

### V2-only columns on `Applicants`

| Column | Type | Notes |
|---|---|---|
| `resume_md_link` | url | Drive link to the generated markdown. |
| `match_percent` | 0–100 int | Primary ranking key. |
| `match_verdict` | enum | `strong` \| `possible` \| `weak` \| `unscorable`. |
| `scored_at` | ISO8601 | |
| `scoring_model` | string | Which model actually produced it (audit trail). |

### Other tabs

| Tab | Purpose |
|---|---|
| `Templates` | `template_id`, `name`, `job_role`, `category`, `stage`, `html`, `source` (`uploaded`\|`ai`), `is_active`, `updated_at`. |
| `JobRoles` | `role_id`, `title`, `department`, `is_open`. V2 adds `jd_markdown`, `must_haves`, `nice_to_haves`, `weights_json`. |
| `EmailLog` | Append-only. One row per send attempt: `correlation_id`, `applicant_id`, `to`, `subject`, `provider`, `result`, `provider_message_id`, `error_code`, `at`. |
| `Replies` | `applicant_id`, `thread_id`, `from`, `received_at`, `snippet`, `classified_intent`, `confidence`, `handled_by`, `handled_at`. |
| `RunLog` | One row per workflow execution: `correlation_id`, `workflow`, `trigger`, `started_at`, `finished_at`, `items_in`, `items_ok`, `items_failed`, `status`. |
| `Errors` | Dead-letter queue. `correlation_id`, `applicant_id`, `workflow`, `node`, `error_code`, `error_message`, `payload_json`, `retry_count`, `resolved`. |
| `Quota` | Live counters per provider/model: `provider`, `model`, `window`, `requests_used`, `tokens_used`, `window_reset_at`. |
| `Config` | Key/value runtime switches (feature toggles, dry-run flag, batch size). |
| `Analysis` *(V2)* | Full scoring detail: `applicant_id`, `job_role`, `match_percent`, per-criterion scores, `strengths`, `gaps`, `evidence_quotes`, `model`, `prompt_version`, `raw_json`. |

### Stage state machine

```
V1:   NEW ──▶ DRAFTED ──▶ APPROVED ──▶ SENT ──▶ REPLIED ──▶ CLOSED
       │         │            │          │
       └─────────┴────────────┴──────────┴──────▶ FAILED (recoverable, retryable)

V2:   NEW ──▶ PARSED ──▶ SCORED ──▶ SHORTLISTED ──▶ DRAFTED ──▶ … (as V1)
                            │
                            └──▶ REJECTED (auto below threshold, or manual)
```

Rules: transitions are one-way except `FAILED → <previous stage>` on retry.
A row may only be picked up by a workflow if `status != pending` (prevents double
processing when two runs overlap).

---

## §3 — Stack & free hosting

| Component | Choice | Free-tier reality | Fallback |
|---|---|---|---|
| **Workflow engine** | n8n (self-hosted, Docker) | **Oracle Cloud Always Free** ARM VM (4 vCPU / 24 GB, no expiry, no card charge) — the only genuinely always-on free option. | Render free web service (spins down after ~15 min idle → cron triggers get missed; acceptable only if all triggers are webhook-driven) |
| **n8n database** | Postgres on the same VM (Docker) | Free with the VM. | SQLite (simpler, fine for single-instance) |
| **Dashboard** | Next.js (App Router) on **Vercel Hobby** | Free, generous for internal use. Serverless routes hold the n8n webhook secret. | Cloudflare Pages + Functions |
| **Data store** | Google Sheets + Google Drive | Free with a Google account. Service account for API access. | — |
| **AI — primary** | Groq API (free tier) | Rate-limited; see §7. | — |
| **AI — fallback** | Google Gemini API (free tier) | Separate quota pool → real redundancy, not just retry. | Local none — pipeline pauses |
| **Email send** | Gmail API via n8n OAuth (HR's own mailbox) | ~500 sends/day on a consumer account. Replies land in the same mailbox → reply tracking is free. | Resend / Brevo free tier if a custom domain is wanted |
| **Reply ingestion** | Gmail trigger in n8n (polling) | Free. | IMAP node |
| **Secrets** | n8n credentials store + Vercel env vars | Free. | — |
| **Uptime / alerting** | UptimeRobot free (5 min checks) on n8n `/healthz` | Free. Also keeps a Render deploy warm if that fallback is used. | Cron-job.org |
| **Repo / CI** | GitHub + GitHub Actions | Free for this scale. Workflow JSON linting + dashboard build check. | — |

**[DECIDE] Hosting**: Oracle Cloud Always Free requires a card for identity
verification (not charged) and account approval can be slow/regionally flaky.
If that's a blocker, say so and the plan drops to Render + webhook-only triggers,
with the cron-driven parts moved to GitHub Actions `schedule:` calling n8n webhooks.

---

## §4 — Repository layout

```
hr-automation/
├── README.md                  # zero-to-running, kept current every milestone
├── PLAN.md                    # this file
├── GOAL.md
├── .env.example
├── docs/
│   ├── architecture.md
│   ├── data-model.md          # §2, expanded, canonical
│   ├── error-codes.md         # §8 catalogue, canonical
│   ├── ai-routing.md          # §7 routing + limits + measured throughput
│   ├── runbook.md             # "X is broken → do Y"
│   └── deployment.md          # Oracle VM + Vercel + Google setup, step by step
├── n8n/
│   ├── docker-compose.yml
│   ├── Caddyfile              # TLS termination
│   ├── workflows/             # exported JSON, version-controlled
│   │   ├── WF-01-intake.json
│   │   ├── WF-02-draft.json
│   │   └── …
│   └── README.md              # import/export procedure
├── prompts/
│   ├── draft-email.v1.md
│   ├── generate-template.v1.md
│   ├── resume-to-markdown.v1.md
│   ├── score-resume.v1.md
│   └── classify-reply.v1.md   # versioned; prompt_version recorded per row
├── dashboard/                 # Next.js app
│   ├── app/
│   ├── lib/sheets.ts
│   ├── lib/n8n.ts             # HMAC signing, typed action calls
│   └── lib/errors.ts          # shared error-code map
└── scripts/
    ├── bootstrap-sheets.ts    # creates all tabs + headers idempotently
    ├── seed-demo-data.ts
    └── export-workflows.sh
```

**Prompt versioning** matters: every generated artefact records
`prompt_version`, so when a prompt changes you can tell old output from new.

---

## §5 — V1: Outreach engine

**Goal:** HR drops applicants into a sheet; the system writes a role-appropriate,
template-shaped email for each; HR reviews and bulk-sends from a dashboard;
replies come back classified and visible.

### n8n workflows

| ID | Name | Trigger | Does |
|---|---|---|---|
| **WF-01** | Intake & normalise | Google Sheets trigger (new/changed row) + Form webhook | Validate email/role/category, dedupe by email+role, mint `applicant_id`, resolve Drive file ID, set `stage=NEW`. Bad rows → `status=blocked` + `E-INTAKE-*`, never silently dropped. |
| **WF-02** | Draft generation | Dashboard webhook (`/draft`, single or bulk) | Pick template (role+category+stage match, else default), fetch applicant context, call AI Router, produce `{subject, html}`, validate HTML (no unclosed tags, all merge fields resolved), write to `Applicants` + `Drafts`, `stage=DRAFTED`. |
| **WF-02b** | Template generation | Dashboard webhook (`/template/generate`) | HR gives tone + intent; AI returns an HTML template with `{{merge_fields}}`; saved to `Templates` with `source=ai`, inactive until HR activates it. |
| **WF-03** | Send | Dashboard webhook (`/send`) | Re-verify draft exists & is approved, honour `DRY_RUN`, send via Gmail, capture `thread_id` + `provider_message_id`, append `EmailLog`, `stage=SENT`. Per-recipient failure isolation — one bad address never aborts a batch. |
| **WF-04** | Reply watcher | Gmail trigger, every 5 min | Match inbound by `thread_id` (fallback: from-address + role), classify intent via AI (`interested` / `declined` / `question` / `out-of-office` / `unclear`), write `Replies`, update `reply_state`. Low confidence → `needs_human`, never auto-acted on. |
| **WF-05** | Follow-up | Cron daily | Candidates `SENT` + no reply after N days → flag for follow-up. **Drafts only; sending stays manual in V1.** |
| **WF-90** | Error handler | n8n Error Trigger (global) | Catches every unhandled failure in every workflow → `Errors` tab + `RunLog` + optional email/Telegram ping. |
| **WF-91** | Heartbeat | Cron every 10 min | Writes a liveness row; dashboard shows "n8n last seen 2 min ago". Detects the silent-death case where nothing errors because nothing runs. |

### Dashboard (V1)

- **Applicants table** — filter by role / category / stage / status, search, bulk select.
- **Function toggles** — the panel from GOAL.md: each automation (intake, drafting,
  sending, reply watching, follow-ups) has an on/off switch backed by `Config`, plus a
  live status light (last run, last error, items processed). Toggling writes to `Config`;
  workflows read it as their first node and no-op when off.
- **Template manager** — upload HTML, or generate with AI; live preview with sample
  merge data; activate/deactivate; per-role/category assignment.
- **Draft review** — side-by-side applicant context and rendered email; edit inline;
  approve / regenerate / discard. Nothing sends without an approved draft.
- **Bulk actions** — "Send to all approved in role X", with a confirm dialog that names
  the exact recipient count and lists the addresses. Dry-run toggle prominent.
- **Email log** — every attempt, with provider response and error code.
- **Reply inbox** — classified replies, one-click "mark handled", jump to Gmail thread.
- **Run & error console** — `RunLog` + `Errors`, filterable, with a **Retry** button that
  re-invokes the failed item by `correlation_id`.
- **Auth** — NextAuth Google sign-in restricted to an allowlist of HR emails.

### V1 milestones

| M | Deliverable | Done when |
|---|---|---|
| **M0** | Foundations | Repo scaffolded, Oracle VM + n8n + Caddy up on HTTPS, Google service account + OAuth working, `bootstrap-sheets.ts` creates all tabs, README gets someone from zero to a running n8n. |
| **M1** | Intake | Form and manual rows both produce valid `Applicants` rows; malformed input produces a typed `E-INTAKE-*` and a visible blocked row. |
| **M2** | Templates + drafting | Upload and AI-generated templates both render; WF-02 drafts for one applicant, then for 20 in a batch, with fallback to Gemini proven by disabling Groq. |
| **M3** | Sending | Dry-run send verified end-to-end; real send to 2 test addresses; `thread_id` captured; one deliberately bad address proves per-item isolation. |
| **M4** | Replies | Reply to a sent email appears classified in the dashboard within one poll cycle. |
| **M5** | Console + hardening | Error console with working retry; WF-90 catches an injected failure; toggles verified to actually stop workflows; **README + docs/ complete → V1 ship.** |

### V1 acceptance criteria

1. 50 applicants imported → drafted → reviewed → sent, with zero manual sheet editing.
2. Every failure mode in §8 has been deliberately triggered once and produced the right code in `Errors`.
3. Killing the Groq key mid-batch causes a clean Gemini failover, recorded per row.
4. Killing *both* keys pauses the batch — no partial or empty emails sent, rows stay retryable.
5. A fresh machine can reproduce the whole system from README alone.

---

## §6 — V2: Resume parsing, scoring & ranking

**Goal:** everything in V1, plus: resumes become markdown, markdown is scored
against the job description, and HR sees a ranked list with a defensible match
percentage before deciding who to email.

### New n8n workflows

| ID | Name | Trigger | Does |
|---|---|---|---|
| **WF-10** | Resume → Markdown | Queue runner picks `stage=NEW` with a resume | 1) Download from Drive/URL. 2) **Deterministic text extraction first** (n8n Extract-from-File / `pdf-parse`) — free, no tokens. 3) If extracted text is empty or gibberish (scanned/image PDF), fall back to **Gemini multimodal OCR** (Groq has no PDF vision path). 4) LLM structures the text into a fixed markdown schema. 5) Save `.md` to Drive, link it, `stage=PARSED`. |
| **WF-11** | Score vs JD | Queue runner picks `stage=PARSED` | Load `jd_markdown` + `weights_json` for the role, score against fixed criteria, emit strict JSON: per-criterion score, weighted `match_percent`, strengths, gaps, and **evidence quotes lifted from the resume**. Schema-validated; invalid JSON → one repair retry → then `E-LLM-SCHEMA`. `stage=SCORED`. |
| **WF-12** | Queue runner | Cron, every minute | The heart of §7: reads `Quota`, computes how many items fit in the current token/request budget, claims that many rows atomically (`status=pending` + lease timestamp), dispatches, releases. Stale leases (>15 min) are reclaimed. |
| **WF-13** | ETA reporter | Cron, every 5 min | Recomputes queue depth × per-item cost ÷ remaining budget → writes an ETA the dashboard displays. |

### Markdown schema (fixed, so scoring is comparable across candidates)

```markdown
# {Name}
## Contact
## Summary
## Skills            <- flat list, normalised casing
## Experience        <- repeated: **{Title}** — {Company} ({start}–{end}) + bullets
## Education
## Projects
## Certifications
## Raw Notes         <- anything unclassifiable, never discarded
```

Unparseable sections are emitted as empty headings, never omitted — a stable shape
means the scoring prompt never has to guess.

### Scoring model

`match_percent = Σ(criterion_score × weight) / Σ(weights) × 100`, with weights per
role in `JobRoles.weights_json`. Default criteria: must-have skills (40), relevant
experience depth (25), domain/industry fit (15), education & certifications (10),
communication quality of the resume itself (10). **[DECIDE]** the default weights.

Two guardrails, both non-negotiable:

- **Every score cites evidence.** A criterion score with no supporting quote from the
  resume is treated as a hallucination → clamp to 0 and flag `needs_human`.
- **The score never auto-rejects.** It sorts and suggests; a human moves anyone to
  `REJECTED`. Auto-reject below a threshold is available but **off by default**.

### Dashboard additions (V2)

- **Ranked view** — sortable by `match_percent`, colour-coded verdict, per-role leaderboards.
- **Scorecard drawer** — criterion breakdown with the evidence quotes, side by side with the rendered resume markdown.
- **JD manager** — write/edit job descriptions and weights per role, versioned.
- **Throughput panel** — quota meters per provider/model (requests + tokens, current window), queue depth, live ETA, and which model is currently serving.
- **Re-score** — re-run one applicant or a whole role after a JD or prompt change; old scores retained for comparison.
- **Shortlist → outreach handoff** — select from the ranked list and drop straight into the V1 drafting flow.

### V2 milestones

> Sequenced for delivery. For the learning-ordered version of the same work —
> smaller steps, each naming the JavaScript concept it needs — see
> [LEARN.md](LEARN.md) Part 6.

| M | Deliverable | Done when |
|---|---|---|
| **M6** | Parsing | 20 mixed resumes (text PDF, scanned PDF, DOCX, Drive link, external URL) all produce schema-valid markdown or a typed failure. |
| **M7** | Scoring | Scores are schema-valid, evidence-backed, and stable: re-running the same resume twice moves `match_percent` by ≤5 points. |
| **M8** | Queue + limiter | A 100-resume batch runs to completion across quota windows without a single 429 reaching a row; forced 429s prove the backoff path. |
| **M9** | Ranking UI | Ranked view, scorecards, throughput panel, JD manager all live. |
| **M10** | Integration + ship | Shortlist→draft→send works end to end; docs and README updated; **V2 ship.** |

### V2 acceptance criteria

1. 100 resumes go from raw upload to ranked list with no manual intervention and no lost rows.
2. The ETA shown before a batch is within ±20% of actual.
3. Every scored row can answer "why this number?" with per-criterion evidence.
4. Groq exhaustion mid-batch spills to Gemini and the batch still finishes.
5. Both providers exhausted → batch pauses, resumes automatically at window reset, nothing double-processed.

---

## §7 — AI routing, rate limits & throughput

### Routing policy

| Task | Primary | Fallback 1 | Fallback 2 | Why |
|---|---|---|---|---|
| Email drafting | Groq 70B-class | Gemini Flash | — | Quality matters; volume is low (1 call/applicant). |
| Template generation | Groq 70B-class | Gemini Flash | — | Rare, interactive. |
| Reply classification | Groq 8B-class | Gemini Flash | — | Short input, cheap, high volume. |
| Resume → markdown structuring | Groq 8B-class | Gemini Flash | — | Long input, mechanical task; a small model is enough. |
| Scanned-PDF OCR | **Gemini Flash (multimodal)** | — | manual flag | Groq has no PDF-vision path. |
| Resume scoring | Groq 70B-class | Gemini Flash | Groq 8B-class | Judgement task — worth the big model; 8B only as a last resort, and the row records which model scored it. |

Failover triggers: HTTP 429 with no usable `retry-after`, 5xx after 2 retries,
timeout >60 s, or schema-invalid output twice in a row. Every failover writes
`W-AI-FAILOVER` to `RunLog` with the reason — silent degradation is a bug.

### Limits — config, not constants

**Free-tier limits change without notice.** They live in `Config`/`Quota`, not in
code, and the limiter also reads Groq's live response headers
(`x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`, `retry-after`)
to self-correct. The numbers below are **planning placeholders — verify in the
Groq and Google AI consoles at M0 and write the real ones into `Config`.**

| Provider / model | RPM | RPD | TPM | TPD |
|---|---:|---:|---:|---:|
| Groq 8B-class (`llama-3.1-8b-instant`) | 30 | 14,400 | 6,000 | 500,000 |
| Groq 70B-class (`llama-3.3-70b-versatile`) | 30 | 1,000 | 12,000 | 100,000 |
| Gemini Flash | ~15 | ~1,500 | ~1,000,000 | — |

**The binding constraint is TPD, not RPM.** Requests-per-minute is never the wall;
tokens-per-day is. Design accordingly.

### Cost per resume (estimates, to be measured at M6/M7)

| Stage | Model class | In | Out | Total |
|---|---|---:|---:|---:|
| Markdown structuring (text already extracted deterministically) | 8B | ~5,000 | ~1,500 | **~6,500** |
| Scoring vs JD | 70B | ~2,500 | ~800 | **~3,300** |
| Email drafting | 70B | ~1,200 | ~600 | **~1,800** |

Deterministic PDF extraction before the LLM is what makes this affordable — sending
raw PDF bytes through a model would roughly triple the structuring cost.

### Throughput formulas

```
per_minute = min( TPM / tokens_per_item , RPM / requests_per_item )
per_day    = min( TPD / tokens_per_item , RPD / requests_per_item )
ETA        = queue_depth / per_minute        (+ waits at window boundaries)
```

### Worked estimates (using the placeholder limits above)

**Scoring on Groq 70B** — 3,300 tokens/item:
- rate: `12,000 / 3,300` ≈ **3.6 items/min**
- daily cap: `100,000 / 3,300` ≈ **30 items/day**

**Structuring on Groq 8B** — 6,500 tokens/item:
- rate: `6,000 / 6,500` ≈ **0.9 items/min**
- daily cap: `500,000 / 6,500` ≈ **76 items/day**

| Batch | Groq only | Groq + Gemini spillover |
|---|---|---|
| **25 resumes** | ~28 min parse + ~7 min score ≈ **35 min**, same day | ~20 min |
| **100 resumes** | parse-bound at 76/day and score-bound at 30/day → **~4 days** | **~2.5 h** (Gemini's TPM is the escape hatch) |
| **500 resumes** | not viable on free Groq alone | ~2 days, or **[DECIDE]** paid Groq for ~$ single digits |

The honest conclusion: **Groq free alone is comfortable up to ~25–30 resumes/day.**
Past that, Gemini is not a fallback but a co-primary, and the router should
load-balance rather than wait for failure. Building the limiter so provider weights
are config-driven (not hardcoded) is what makes that a config change, not a rewrite.

### Limiter implementation

- **Token bucket per (provider, model)**, persisted in the `Quota` tab so it survives n8n restarts.
- **Pre-flight estimate** — every item's token cost is estimated *before* dispatch and reserved from the bucket; the reservation is reconciled against actual usage from the response.
- **Backoff** — honour `retry-after` when present; otherwise exponential with jitter (2s → 4s → 8s → 16s, max 4 tries), then failover, then dead-letter.
- **Window-boundary parking** — when the daily budget is exhausted, the queue *parks* with a resume-at timestamp shown in the dashboard. It does not spin, and it does not fail the rows.
- **Concurrency cap** of 1 in-flight LLM request per model. Free tiers punish bursts, and the throughput ceiling is TPM anyway — parallelism buys nothing.

---

## §8 — Exception handling

The GOAL's hardest requirement: *"when anything breaks I know exactly what is broken."*

### Error code catalogue (canonical copy: `docs/error-codes.md`)

| Prefix | Domain | Examples |
|---|---|---|
| `E-INTAKE-*` | Bad input | `E-INTAKE-EMAIL` invalid address · `E-INTAKE-ROLE` unknown job role · `E-INTAKE-DUPE` duplicate applicant · `E-INTAKE-MISSING` required field empty |
| `E-FETCH-*` | Resume retrieval | `E-FETCH-404` link dead · `E-FETCH-PERM` Drive permission denied · `E-FETCH-SIZE` over limit · `E-FETCH-TYPE` unsupported format |
| `E-PARSE-*` | Extraction (V2) | `E-PARSE-EMPTY` no extractable text · `E-PARSE-OCR` OCR fallback failed · `E-PARSE-SCHEMA` markdown missing required sections |
| `E-LLM-*` | Model layer | `E-LLM-TIMEOUT` · `E-LLM-SCHEMA` invalid JSON after repair retry · `E-LLM-REFUSAL` model declined · `E-LLM-EMPTY` blank response |
| `E-QUOTA-*` | Rate limits | `E-QUOTA-RPM` · `E-QUOTA-TPD` daily budget exhausted (→ park, not fail) · `E-QUOTA-ALL` every provider exhausted |
| `E-MAIL-*` | Sending | `E-MAIL-AUTH` OAuth expired · `E-MAIL-BOUNCE` · `E-MAIL-LIMIT` daily send cap hit · `E-MAIL-TEMPLATE` unresolved merge field |
| `E-SHEET-*` | Sheets API | `E-SHEET-429` · `E-SHEET-PERM` · `E-SHEET-SCHEMA` expected column missing |
| `E-CONFIG-*` | Setup | `E-CONFIG-MISSING` required env var absent · `E-CONFIG-CRED` credential invalid |
| `W-*` | Warnings (non-fatal) | `W-AI-FAILOVER` · `W-TEMPLATE-DEFAULT` no role-specific template, used default · `W-SCORE-LOWCONF` |

### Handling rules

1. **Every node that can fail has a defined failure path.** No bare `continueOnFail`; every catch writes a typed code.
2. **Correlation ID per run**, minted at trigger, stamped on every row, log line, and error. One ID reconstructs the entire history of a batch.
3. **Item-level isolation.** One bad applicant never aborts a batch of 100 — it lands in `Errors` and the batch continues.
4. **Retry classification** — transient (429, 5xx, timeout) retries automatically with backoff; permanent (bad email, dead link, unsupported file) does not retry and is surfaced for a human immediately.
5. **Dead-letter with full payload.** `Errors` stores the input payload as JSON, so a retry needs no reconstruction.
6. **Config validation at startup.** A dedicated `WF-00 Preflight` runs on deploy and on demand: checks every credential, every sheet tab, every required column, every API key's live reachability, and reports a green/red table to the dashboard. Most "mysterious" failures are config drift — this catches them before a run.
7. **Alerting** — `E-QUOTA-ALL`, `E-CONFIG-*`, `E-MAIL-AUTH`, and any error rate >10% in a run trigger an immediate notification. **[DECIDE]** email vs Telegram vs both.
8. **Dry-run mode** — `DRY_RUN=true` in `Config` makes WF-03 log exactly what it *would* send without sending. Default ON in any non-production setup.
9. **The dashboard shows red.** A failed row is red in the table, with the code and message inline and a retry button. Debugging never requires opening n8n.

### Testing

- **Fault injection suite** — a script that deliberately triggers each error code (bad key, revoked Drive permission, malformed sheet, forced 429, unsupported file, unresolved merge field) and asserts the right code lands in `Errors`. Run before every ship.
- **Golden-file tests** for parsing and scoring: fixture resumes with expected markdown shape and expected score bands.
- **Contract test** — a CI check asserting that the sheet's header row still matches the columns the code expects, catching `E-SHEET-SCHEMA` before runtime.

---

## §9 — Security & privacy

Resumes are personal data; treat them that way.

- Service account scoped to **one** spreadsheet and **one** Drive folder — not the whole account.
- No API keys in the dashboard bundle. All secrets in n8n credentials + Vercel server-side env.
- Dashboard→n8n webhooks are HMAC-signed with a timestamp and a short replay window; unsigned requests are rejected.
- Google sign-in allowlist for HR emails; no public routes beyond the sign-in page.
- Candidate PII never enters logs — logs carry `applicant_id`, never resume text or email bodies.
- Bulk-send confirmation always names the exact recipient count; no way to send to "everything" in one accidental click.
- `.env.example` only; real `.env` gitignored, and a CI secret-scan on push.
- **[DECIDE]** Retention policy — how long do resumes and markdown stay in Drive?

---

## §10 — Build order

```
M0 ──▶ M1 ──▶ M2 ──▶ M3 ──▶ M4 ──▶ M5   ═══ V1 SHIPS ═══
Foundations  Intake  Draft  Send  Reply  Console

                                          M6 ──▶ M7 ──▶ M8 ──▶ M9 ──▶ M10
                                          Parse  Score  Queue  UI    Ship
                                                                    ═══ V2 ═══
```

Rules of engagement:

- **README is updated in the same commit as the change it describes.** Not at the end.
- Each milestone ends with: workflows exported to `n8n/workflows/`, docs updated, fault-injection suite green.
- V2 work does not begin until V1's acceptance criteria pass on real data.
- Prompts are versioned from day one — bump `prompt_version` on every meaningful edit.

---

## §11 — Open decisions

| # | Question | Blocks | State |
|---|---|---|---|
| 1 | Oracle Cloud Always Free viable, or fall back to Render + webhook-only triggers? | M0 | **Resolved** — Oracle primary, Render documented as fallback with its scheduled-trigger caveat |
| 2 | Final `category` enum and initial job-role list. | M1 | **Open** — shipped a default of `Intern,Junior,Mid,Senior,Lead` in the Config tab. Edit it there; no code change needed. |
| 3 | Send from HR's Gmail or a custom domain via Resend/Brevo? | M3 | **Resolved** — Gmail. Replies land in the same mailbox, which is what makes reply tracking free. |
| 4 | Expected volume — applicants per week? Determines whether Gemini is a fallback or a co-primary (§7). | M8 | **Open, and the most consequential.** Under ~50 personalised drafts/day the current setup is comfortable. Above that, the router should load-balance rather than fail over — a config change to `ROUTES` in `ai-router.js`, not a rewrite. |
| 5 | Default scoring weights per criterion. | M7 | Open — V2 |
| 6 | Alert channel: email, Telegram, or both. | M5 | **Resolved** — email to `ALERT_EMAIL`, fatal severity only. Telegram is a node swap in WF-90 if wanted. |
| 7 | Resume retention policy. | M6 | Open — V2 |
| 8 | GOAL.md line 35 ends mid-sentence — *"For dashboard and things other than n8n please use the md file that we can…"* | — | **Assumed and acted on**: all non-n8n components are specced in in-repo markdown (`docs/`, `prompts/`, per-directory READMEs). Say if something else was meant. |
| 9 | Per-user dashboard sign-in — needed now, or later? | — | **New.** Shipped with a shared team password. Needed as soon as you want to know *which* person approved an email, or need to revoke one person's access. |

---

## §12 — Explicitly out of scope

Named so they don't creep in: ATS integrations (Greenhouse/Lever), interview
scheduling and calendar sync, offer-letter generation, candidate-facing portal,
multi-tenant / multi-company support, SMS or WhatsApp outreach, video-interview
analysis, and any automated hire/reject decision without a human in the loop.
