# Runbook

Organised by symptom. For code definitions see
[error-codes.md](error-codes.md).

**Always start here:** Dashboard → **Console** → **Run preflight**. It checks
every credential, environment variable and Config key without writing or sending
anything, and most problems are config drift.

---

## Nothing is happening at all

The dashboard shows a red *"n8n has not checked in"* banner, or no workflow has
run in a while.

This is the failure that produces no errors — nothing runs, so nothing fails.

1. **Is n8n up?**
   ```bash
   ssh user@server
   cd hr-automation/n8n
   docker compose ps          # all services "Up"?
   docker compose logs --tail=100 n8n
   ```
2. **Out of disk?** The usual cause on a small VM.
   ```bash
   df -h
   docker system prune -a     # if the disk is full
   ```
   Executions are pruned after 14 days by `EXECUTIONS_DATA_MAX_AGE`.
3. **Are the workflows active?** In n8n, each should show a green *Active*
   toggle. An import leaves them inactive.
4. **On Render:** the free tier sleeps after ~15 minutes idle and misses
   scheduled triggers entirely. See deployment.md §1.

---

## Applicants are not appearing

New rows sit in the sheet and never get an `applicant_id`.

1. **Settings → is *Intake* on?** A run with `status = skipped` in RunLog names
   the toggle.
2. **Is WF-01 active in n8n?**
3. **Check the Errors tab** — the row is probably blocked, not ignored. Blocked
   rows keep `status = blocked` with the reason in `error_message`.
4. **Is the row genuinely new?** WF-01 only touches rows with no
   `applicant_id` and no `stage`. To reprocess one, clear both cells.
5. **`E-INTAKE-ROLE`?** `job_role` must match a `title` in the JobRoles tab
   (case and spacing are ignored, spelling is not).

---

## Drafts are not generating

1. **Settings → is *Drafting* on?**
2. **Is there an active template?** Templates page — at least one must be
   `active`, and one should be `default`. Without a match you get
   `E-MAIL-TEMPLATE: No template matches role "X" and no default template is set`.
3. **`E-QUOTA-TPD` or `E-QUOTA-ALL`?** Out of budget. Not a failure — the rows
   stay `NEW` and resume at the reset. Add `GEMINI_API_KEY` to roughly double
   the daily ceiling.
4. **`E-LLM-AUTH`?** Bad API key. Fix `n8n/.env`, then
   `docker compose up -d` to restart with the new value.
5. **`E-LLM-SCHEMA` on one applicant?** The model returned unusable JSON twice.
   Only that applicant failed. Retry it; if it recurs for the same person, an
   unusual character in their name or role is likely confusing the prompt.

---

## Emails are not sending

Work down this list — it is ordered by likelihood.

1. **Is *dry run* on?** Settings page. Dry runs write `dry-run` rows to EmailLog
   and send nothing. This is the intended default.
2. **Settings → is *Sending* on?** Ships off.
3. **Is the row `APPROVED`?** `DRAFTED` is not enough — approval is a separate,
   deliberate step. `E-MAIL-NODRAFT` means it was not approved.
4. **`E-MAIL-TEMPLATE`?** The draft still has an unresolved `{{field}}`. Nothing
   was sent, by design.
5. **`E-MAIL-LIMIT`?** Daily cap hit (`send_daily_cap`, default 400). Resumes
   tomorrow.
6. **`E-MAIL-AUTH`?** Gmail OAuth expired. Reconnect *HR Gmail* in n8n →
   Credentials.
7. **One recipient failed, the rest went out?** Working as intended —
   per-recipient isolation. That row keeps `APPROVED` and is retryable.

---

## Replies are not being picked up

1. **Settings → is *Reply watcher* on?**
2. **Is WF-04 active?** It polls every 5 minutes; wait one cycle.
3. **Is the Gmail credential connected to the right mailbox?** It must be the
   account that sent the outreach.
4. **Does the applicant have a `thread_id`?** Matching is by thread id first. A
   row sent during a dry run has no thread id and cannot be matched that way —
   the sender-address fallback still works if the row is `SENT`.
5. **The trigger filters `is:unread -from:me`.** A reply already read in Gmail is
   skipped. Mark it unread to reprocess.
6. **Mail that is not from a candidate is ignored silently.** That is correct
   behaviour, not a failure.

---

## The dashboard shows an error banner

| Message | Cause | Fix |
|---|---|---|
| *Permission denied reading the "X" tab* | Sheet not shared | Share with the service account as Editor |
| *missing column(s)* | Schema drift | `npm run bootstrap:sheets` |
| *GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON* | Truncated or escaped paste | Paste the whole file, unescaped |
| *Could not reach n8n* | Wrong URL, container down, bad TLS | Check `N8N_BASE_URL` (no trailing slash) and `docker compose ps` |
| *n8n rejected the request signature* | Secret mismatch or clock skew | `N8N_WEBHOOK_SECRET` must be byte-identical on both sides; check both clocks |
| *Webhook /draft does not exist* | Workflow imported but **not activated** | Activate it — inactive workflows only serve the `/webhook-test/` URL |
| *n8n did not respond within 280s* | Long batch | It is probably still running. **Check the Console before retrying** — retrying may duplicate work |

---

## An action reports partial success

*"Partly done — 8 succeeded, 2 failed"* is a normal outcome, not a bug. Expand
the failed items in the banner, or open the Console page: each failure has its
own code and fix, and the successes are already committed.

---

## Recovering a stuck row

| Situation | Do |
|---|---|
| Stuck in `FAILED` | Fix the underlying cause, then select it and **Generate drafts** again. `FAILED` can roll back to any earlier stage. |
| Stuck in `blocked` | Fix the offending cell, then clear the `status` cell. WF-01 reprocesses it. |
| Sent by mistake | You cannot unsend. Set `stage` to `CLOSED` and handle it by hand. |
| Draft looks wrong | **Unapprove**, then **Generate drafts** again — it overwrites the draft. |
| Reprocess from scratch | Clear `applicant_id`, `stage` and `status`. It is treated as a new row. |

---

## Changing the AI's behaviour

Edit the prompt in `n8n/src/lib/pipeline.js` (`buildDraftPrompt`,
`buildReplyPrompt`), bump the version in `prompts/*.md`, then:

```bash
npm test
npm run build:workflows
```

Re-import the affected workflow. **Never edit a Code node inside n8n** — the
next build overwrites it.

To change *which* model handles a task, edit `ROUTES` in
`n8n/src/lib/ai-router.js`. To change quota assumptions, edit `MODELS` there.

---

## Rotating a secret

| Secret | How |
|---|---|
| `GROQ_API_KEY` / `GEMINI_API_KEY` | Edit `n8n/.env`, `docker compose up -d` |
| `N8N_WEBHOOK_SECRET` | Change in **both** `n8n/.env` and the dashboard env, then restart both. Actions fail until they match. |
| Service account key | Create a new key, update the n8n credential, the root `.env`, and `GOOGLE_SERVICE_ACCOUNT_JSON` in Vercel. Delete the old key last. |
| `DASHBOARD_PASSWORD` | Change in Vercel and redeploy. Existing sessions survive up to 12 hours; also change `SESSION_SECRET` to invalidate them immediately. |
| `N8N_ENCRYPTION_KEY` | **Do not.** Changing it orphans every stored credential and they must all be recreated. |

---

## Deliberately breaking things (fault injection)

Worth doing once before you trust the system. Each should produce the named
code, visible on the Console page, with nothing else disturbed:

| Break this | Expect |
|---|---|
| Put a nonsense `job_role` on a new row | `E-INTAKE-ROLE`, row blocked |
| Empty the `name` cell | `E-INTAKE-MISSING`, row blocked |
| Duplicate an existing email + role | `E-INTAKE-DUPE` |
| Set `GROQ_API_KEY=broken`, restart | `W-AI-FAILOVER` — Gemini serves it, drafting still works |
| Break **both** keys | `E-LLM-AUTH`; rows fail individually, batch continues |
| Add `{{interview_date}}` to a template, then send | `E-MAIL-TEMPLATE`, **nothing sent** |
| Approve a row, corrupt its email address, send | `E-MAIL-BOUNCE` on that row only |
| Rename a column in the Applicants tab | `E-SHEET-SCHEMA` on the next read |
| Change `N8N_WEBHOOK_SECRET` on one side only | *signature rejected* on every action |
| Stop the n8n container | Heartbeat banner within ~25 minutes |

If any of these fails silently instead, that is a bug worth fixing before going
live.
