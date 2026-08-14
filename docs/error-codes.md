# Error codes

Every failure in this system carries one of these codes. The canonical
definitions — including retry semantics — live in
[`n8n/src/lib/errors.js`](../n8n/src/lib/errors.js); this document explains what
each one means in practice.

Codes appear in the `Errors` tab, in the `error_code` column on `Applicants`,
and inline on the dashboard's Console page.

## How to read a code

```
E-MAIL-TEMPLATE
│ │    └── the specific problem
│ └─────── the subsystem
└───────── E = error, W = warning (recorded, never fatal)
```

Three properties drive behaviour:

| Property | Meaning |
|---|---|
| **retryable** | Transient. Backs off and retries automatically. |
| **park** | Not a failure — the work stops and resumes at the next quota window. Rows stay untouched and retryable. |
| **severity** | `warn` · `error` · `fatal`. Only `fatal` sends an alert email. |

---

## E-INTAKE-* — bad input

A blocked row stays in the sheet with `status = blocked` and its reason
attached. Fix the cell and clear the `status` column to reprocess.

| Code | Cause | Fix |
|---|---|---|
| `E-INTAKE-MISSING` | `name`, `email` or `job_role` empty | Fill it in. All missing fields are reported together. |
| `E-INTAKE-EMAIL` | Address is not parseable | Correct the typo. |
| `E-INTAKE-ROLE` | `job_role` has no match in the JobRoles tab | Add the role there, or fix the spelling. Matching ignores case and spacing. |
| `E-INTAKE-CATEGORY` | Category not in the allowed list | See the `categories` key in Config. |
| `E-INTAKE-DUPE` | This email already applied for this role | Delete the duplicate. Same person, *different* role is allowed. |

---

## E-FETCH-* — resume retrieval

Mostly dormant in V1 (outreach does not need the file); they carry the load in V2.

| Code | Cause | Fix |
|---|---|---|
| `E-FETCH-404` | Link is dead | Ask the candidate to resubmit. |
| `E-FETCH-PERM` | Drive file not shared with the service account | Share the resumes folder with it. |
| `E-FETCH-SIZE` | Over `max_resume_mb` | Raise the limit or ask for a smaller file. |
| `E-FETCH-TYPE` | Unsupported format, or `resume_link` is not an http(s) URL | Accepted: pdf, doc, docx, txt, md. |
| `E-FETCH-NET` | Network failure. **Retries.** | Usually resolves itself. |

---

## E-LLM-* — model layer

| Code | Cause | Fix |
|---|---|---|
| `E-LLM-AUTH` | **Fatal.** Key rejected | Check `GROQ_API_KEY` / `GEMINI_API_KEY` in `n8n/.env`, restart the container. Not retried — it fails over immediately. |
| `E-LLM-TIMEOUT` | No response in 60s. **Retries.** | Self-resolving. Persistent timeouts mean provider trouble; the Gemini fallback covers it. |
| `E-LLM-SERVER` | Provider 5xx. **Retries**, then fails over. | Nothing to do. |
| `E-LLM-EMPTY` | Empty response. **Retries.** | Nothing to do. |
| `E-LLM-SCHEMA` | Invalid JSON, including after one repair attempt | A prompt problem, not a data problem. Check `prompts/`. Only the affected applicant fails. |
| `E-LLM-REFUSAL` | Model declined | Almost always a prompt issue. Fails over to the next model. |

**On failover.** When Groq fails and Gemini succeeds, `W-AI-FAILOVER` is recorded
on the row. The work succeeded — but repeated failovers mean the primary is
unhealthy.

**On error precedence.** If Groq fails substantively and Gemini is simply not
configured, the reported code is Groq's real failure, not "no Gemini key". A
skipped provider never masks a real one.

---

## E-QUOTA-* — rate limits

**These are not failures.** No data is lost, no row is corrupted, nothing is
half-sent. Work stops and resumes.

| Code | Cause | Fix |
|---|---|---|
| `E-QUOTA-RPM` | Per-minute limit. **Retries** with backoff. | Nothing to do. |
| `E-QUOTA-TPD` | **Parks.** Daily token budget spent for that model. | Work resumes at the reset. To raise the ceiling, set `GEMINI_API_KEY` — a separate quota pool. |
| `E-QUOTA-ALL` | **Parks.** Every provider is out of budget. | Same. The batch stops cleanly; remaining rows stay `NEW` and are picked up next run. |

The limiter checks the budget *before* dispatch, so an exhausted model is
skipped rather than earning a 429. Live usage is on the Console page.

---

## E-MAIL-* — sending

| Code | Cause | Fix |
|---|---|---|
| `E-MAIL-AUTH` | **Fatal.** Gmail OAuth expired | Reconnect *HR Gmail* in n8n → Credentials. |
| `E-MAIL-BOUNCE` | Address rejected by the server | Correct it. The row stays `APPROVED` and retryable; the rest of the batch is unaffected. |
| `E-MAIL-LIMIT` | **Parks.** Daily cap reached | `send_daily_cap` in Config, default 400, under Gmail's ~500/day. Remaining sends resume tomorrow. |
| `E-MAIL-TEMPLATE` | Unresolved `{{field}}` | **Nothing was sent.** Fix the template or add the missing value. This check exists so `Hi {{first_name}},` never reaches a candidate. |
| `E-MAIL-NODRAFT` | Send requested for a row with no approved draft | Generate and approve first. Also raised when a row is already `sent`, to refuse duplicates. |

---

## E-SHEET-* — Google Sheets

| Code | Cause | Fix |
|---|---|---|
| `E-SHEET-PERM` | **Fatal.** No access | Share the spreadsheet with the service account email as **Editor**. The single most common setup mistake. |
| `E-SHEET-SCHEMA` | **Fatal.** A column is missing | `npm run bootstrap:sheets`. It appends missing columns without touching data. |
| `E-SHEET-429` | Rate limit. **Retries.** | Usually several dashboard tabs polling at once. |

---

## E-CONFIG-* — setup

| Code | Cause | Fix |
|---|---|---|
| `E-CONFIG-MISSING` | **Fatal.** Required env var absent | See `.env.example`. Run WF-00 Preflight for the full list. |
| `E-CONFIG-CRED` | **Fatal.** A credential is invalid or unreachable | Run WF-00 Preflight. If it says *signature rejected*, `N8N_WEBHOOK_SECRET` differs between the dashboard and n8n, or the clocks are more than 5 minutes apart. |

---

## W-* — warnings

Recorded for audit. Nothing is broken.

| Code | Means |
|---|---|
| `W-AI-FAILOVER` | The backup provider served this request. Frequent occurrences mean the primary is unhealthy. |
| `W-TEMPLATE-DEFAULT` | No role-specific template matched, so the default was used — a more generic email than intended. |
| `W-REPLY-LOWCONF` | A reply was classified below `reply_confidence_min`. Forced to `unclear` and flagged `needs_human` rather than acted on. |

---

## E-UNKNOWN

An unclassified failure. The raw message is in the Errors tab and the full stack
trace is in the n8n execution (linked from `payload_json`).

Seeing this repeatedly means a failure mode worth adding to the catalogue in
`n8n/src/lib/errors.js`.

---

## The one failure with no code

**Nothing running at all.** No workflow fires, so nothing fails, so nothing is
logged. WF-91 writes a heartbeat to RunLog every 10 minutes and the dashboard
shows a red banner when it goes stale. If you see that banner, check the
container is up and WF-91 is active.
