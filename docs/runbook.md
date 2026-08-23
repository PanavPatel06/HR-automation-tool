# Runbook

Organised by symptom. For code definitions see
[error-codes.md](error-codes.md).

**Always start here:** Dashboard → **Console** → **Run preflight**. It checks
every credential, environment variable and Config key without writing or
sending anything, and most problems are config drift.

---

## Applicants are not appearing

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

---

## Draft is not generating

1. **Settings → is *Drafting* on?**
2. **Is there an active template?** Templates page — at least one must be
   `active`, and one should be `default`. Without a match you get
   `E-MAIL-TEMPLATE: No template matches role "X" and no default template is set`.
3. **`GROQ_API_KEY` set?** Run preflight — it's the first check.
4. **`E-LLM-SCHEMA` or an HTTP error?** The model returned unusable JSON, or
   Groq rejected the request (bad key, rate limit). Click **Draft** again —
   drafting is per-applicant, so one failure doesn't block the rest of the
   batch.

---

## Emails are not sending

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

---

## Replies are not showing up

There is no automated reply watcher. Open the **Inbox** on a candidate's
thread and click **⟳ Sync from Gmail** — it searches for messages to/from
that address on demand. There's nothing to poll or wait for; if the message
genuinely isn't in the mailbox this pulls from, sync will find nothing to
show.

---

## The dashboard shows an error banner

| Message | Cause | Fix |
|---|---|---|
| *Permission denied reading the "X" tab* | Sheet not shared | Share with the service account as Editor |
| *missing column(s)* | Schema drift | `npm run bootstrap:sheets` |
| *GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON* | Truncated or escaped paste | Paste the whole file, unescaped |
| *GROQ_API_KEY is not set* | Missing env var | Add it to the dashboard environment and redeploy |
| *Gmail is not configured* | Missing Gmail env vars | Optional — set the three `GMAIL_*` vars, or ignore and stay in logged-only mode |

---

## An action reports partial success

*"Partly done — 8 succeeded, 2 failed"* is a normal outcome, not a bug. The
response's `errors` array names each one; the successes are already
committed to the sheet.

---

## Recovering a stuck row

| Situation | Do |
|---|---|
| Stuck in `FAILED` | Fix the underlying cause, then select it and **Draft** again. `FAILED` rows are eligible for drafting. |
| Sent by mistake | You cannot unsend. Set `stage` to `CLOSED` and handle it by hand. |
| Draft looks wrong | **Unapprove**, then **Draft** again — it overwrites the draft. |
| Reprocess from scratch | Clear `stage` and `status`, set `stage` back to `NEW`. |

---

## Changing the AI's behaviour

Edit the prompt in `dashboard/lib/draft.ts` (`buildDraftPrompt`) or the
inline prompt strings in `dashboard/app/api/action/route.ts`
(`reply-ai-draft`, `template-generate`), bump the version string alongside
it, then:

```bash
cd dashboard && npm run typecheck && npm run build
```

To change the model, edit `GROQ_MODEL` in the environment (defaults to
`llama-3.1-8b-instant`) — no code change needed.

---

## Rotating a secret

| Secret | How |
|---|---|
| `GROQ_API_KEY` | Update the dashboard's env var and redeploy. |
| Service account key | Create a new key, update `GOOGLE_APPLICATION_CREDENTIALS` locally and `GOOGLE_SERVICE_ACCOUNT_JSON` on the deploy platform. Delete the old key last. |
| `DASHBOARD_PASSWORD` | Change it on the deploy platform and redeploy. Existing sessions survive up to 12 hours; also change `SESSION_SECRET` to invalidate them immediately. |
| `GMAIL_REFRESH_TOKEN` | Re-run `npm run gmail:oauth` and update the three `GMAIL_*` values. |

---

## Deliberately breaking things (fault injection)

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
