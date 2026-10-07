# HR Automation V2 — Limitations and Improvement Report

**Scope:** This report describes the V2 implementation currently in the repository. It is based on the application code and configuration, not on a live production audit. It does not claim that suggested improvements have been implemented.

## Executive summary

V2 is a useful small-team hiring outreach dashboard: Google Sheets holds the roster and configuration, Groq assists with email drafting, Zoho Mail sends messages and provides on-demand conversation reads, and a human reviews drafts before sending. The project deliberately avoids saving full conversation bodies in Sheets.

It is not yet a complete applicant-tracking system. Intake automation, resume parsing/scoring, Gemini fallback, individual user accounts, background reply monitoring, and larger-scale data handling are not implemented. The most important immediate safety concern is that **dry-run sending still changes applicant state to `SENT` and writes `sent_at`**, even though it does not deliver an email. Dry runs also count toward the application’s daily send cap. Use test records until this behavior is changed or consciously accounted for.

## Current limitations

| Area | Current behavior / limitation | Practical impact |
|---|---|---|
| Dry-run semantics | A dry-run send creates an EmailLog row marked `dry_run=true`, and changes the applicant to `SENT` with a `sent_at` value. It does not deliver the email. | A rehearsal can make a real candidate look contacted. Use dedicated test applicants; don’t use dry-run as a harmless preview on production candidates. |
| Daily send cap | The cap is computed from EmailLog rows with `result=sent`; dry-run rows are included. | Dry runs consume the app-side daily allowance. The configured cap must also stay below the Zoho account’s actual limit. |
| Email + Sheets consistency | Email delivery and Google Sheets writes cannot form one transaction. The bulk-send path sends messages, updates applicant rows, then appends log rows. A later Sheets failure can leave external email and app records out of sync. | After an uncertain send or a Sheets error, check Zoho Sent and EmailLog before retrying; a retry could duplicate an email. |
| Concurrent sending | The cap is read before a batch is sent and is not reserved atomically. Two overlapping send requests may both see the same remaining allowance. | The app-side cap is a guardrail, not a strict quota system under concurrent use. |
| Authentication and roles | The dashboard uses one shared password/session configuration; there are no individual accounts, roles, or per-user audit identities. | Hard to safely share broadly, revoke one person, or determine which operator made a change. |
| Intake | Applicants must be present in the `Applicants` tab. A Google Form normally writes to its own response tab; the app does not itself transform those responses into applicant rows. Also, the current **+ New** route accepts a notes field from the UI but omits it when appending the applicant row. | A Form-to-Applicants bridge (for example, a carefully tested Apps Script) is needed if the Form is the intake source. Notes entered through **+ New** are currently lost; add them in the sheet after creating the row. |
| Applicant tracking | Stages and candidate records are managed in Sheets. There is no resume parser, resume storage workflow, candidate scoring, interview scheduling, or full ATS workflow. | HR still needs other processes/tools for those parts of hiring. |
| Replies and inbox | Zoho message summaries are fetched when a candidate is selected; full bodies are fetched when a thread is opened. There is no background polling, reply notification, automatic reply classification, or automatic `REPLIED` stage update. | The operator must refresh/open the candidate view and update pipeline stages as needed. Inbox loading depends on Zoho/API and service response time. |
| Mail history limit | Candidate message search requests up to 2,000 messages. Thread bodies are then fetched in groups of five. | Very long histories may be truncated, and opening large threads takes additional API calls and time. |
| Availability and latency | The app makes live requests to Google Sheets, Groq, and Zoho. There is no durable queue or background worker; the UI may wait for provider responses. A hosted free service can also have cold-start delays depending on its hosting plan. | Provider outages, rate limits, network delays, or service sleep can interrupt a user action. |
| Data scale | Pages read complete sheet tabs; they are not paginated. | Larger applicant and log tabs will increase latency and may eventually hit provider/runtime limits. |
| AI provider strategy | Groq is the implemented model provider. There is no Gemini fallback, automatic provider failover, or built-in model quota scheduler/throughput estimator. | Groq errors or limits can prevent AI drafting until retried or manually handled. Review AI output before use. |
| AI data handling | Applicant details and notes are included in server-side prompts for relevant drafting actions. | Treat notes as personal data; minimize sensitive details and review the provider’s current data-handling terms and your organization’s policy. |
| Attachments | Direct composer attachments and template attachments are supported up to 15 MiB total. Template attachments are fetched from a URL and must be reachable without a login. | Private Drive links may fail; a public link can expose a file to anyone who obtains it. Avoid sensitive documents and verify permissions. |
| Zoho region | The Zoho Accounts and Mail API endpoints are configured for the India data center. | A mailbox in a different Zoho data center needs a code/configuration change; changing only credentials may not be enough. |
| Recovery / backups | The spreadsheet is the primary roster and configuration store. The app does not provide a database backup/restore workflow. | Keep Google Sheets version history and protect/export important data according to the organization’s retention policy. |

## Improvement roadmap

Priorities below are recommendations, not completed work. “P0” means resolve before relying on the feature for production outreach; “P1” means valuable next; “P2” means scale or product expansion.

### P0 — Safety and data correctness

1. **Make dry-run non-mutating.** Do not set `stage=SENT` or `sent_at` for a simulated delivery. Log it as a dry run while leaving the applicant eligible for a later real send. Add tests proving this for bulk and one-person sending.
2. **Exclude dry runs from the live-send quota.** Count only real delivered sends (`dry_run=false`) when calculating the daily cap, and test that repeated rehearsals do not exhaust the live allowance.
3. **Make send outcomes recoverable.** Use a durable send-attempt state (for example, `pending` → provider accepted → sheet/log finalized), idempotency/reconciliation where the provider supports it, and a clear recovery procedure for timeout or Sheets failure. Never blindly retry an ambiguous provider response.
4. **Make the daily cap safe under concurrency.** Serialize/reserve send capacity or move the quota ledger to a store that supports atomic updates. Keep provider-side sending limits as the ultimate boundary.
5. **Document and test production preflight.** Include a controlled real-send test recipient and a clear go-live checklist; retain dry-run as the default.
6. **Persist notes from + New.** Include the submitted notes in the Applicants append operation, with a regression test that verifies the field is stored.

### P1 — Access, intake, and inbox workflow

1. Add individual sign-in and basic roles (viewer, HR operator, administrator), with per-user attribution for sends and configuration changes.
2. Add an authenticated, validated Form-to-Applicants intake flow with duplicate handling and an operator-visible import/error report.
3. Add optional reply detection/notifications, explicit refresh controls, and a human-confirmed `REPLIED` stage update. Keep full message bodies in Zoho rather than Sheets.
4. Add inbox pagination/date filters and targeted Zoho queries; avoid loading a candidate’s entire history when only recent messages are needed.
5. Add a visible “last refreshed”/provider health state and bounded retry/backoff for transient provider errors.

### P2 — Scale, AI resilience, and governance

1. Introduce pagination and a more suitable data store if sheet size or concurrent use grows; retain Sheets export/import if it remains a required workflow.
2. Add Gemini as an explicitly configured fallback, with provider-specific error handling, quotas, cost/latency visibility, and tests. Do not silently send candidate data to a second provider without policy approval.
3. Add model quota-aware batch scheduling and progress reporting for larger draft batches.
4. Define retention, access, deletion, and audit policies for candidate data, email logs, and provider prompts.
5. Add end-to-end tests against isolated test accounts for Zoho, Google Sheets, and the deployment environment, plus documented backup/restore drills.

## Operational guidance until improvements land

- Keep `dry_run=true` while configuring and testing. Use a clearly marked test applicant because dry-run currently advances the row to `SENT`.
- Before any retry after a timeout/error, inspect Zoho Sent and EmailLog to establish whether the provider accepted the message.
- Review recipient addresses and approved draft contents before sending; use small batches first.
- Keep API credentials server-side and rotate/revoke them if exposed.
- Protect sheet headers, restrict editor access, keep a recoverable version history, and don’t put unnecessary sensitive information in free-text notes.
- Check the current Zoho, Groq, Google, and hosting account limits; the app’s configured cap does not override provider limits.

## Evidence in the codebase

- Applicant and sheet contract: `lib/schema.js`, `dashboard/lib/contract.ts`
- Send, dry-run, quota, and preflight actions: `dashboard/app/api/action/route.ts`
- Zoho OAuth, message listing, and thread-body reads: `dashboard/lib/mailer.ts`, `dashboard/app/api/inbox/route.ts`
- Full-sheet reads and Google Sheets access: `dashboard/lib/sheets.ts`
- Runtime configuration: `render.yaml`, `dashboard/.env.example`
