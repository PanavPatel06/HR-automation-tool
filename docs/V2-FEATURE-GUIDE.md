# HR Automation V2 — Feature Guide

This guide describes the features present in the current V2 code. It is for HR operators using the deployed dashboard, not for deployment setup. The main data source is the Google Sheet; Zoho Mail remains the source of conversation history.

## Before using the dashboard

- Sign in with the dashboard password provided by the administrator.
- Confirm the administrator has configured Google Sheets, Groq, and Zoho credentials.
- Start with **Settings** and **Console → Run preflight**. Keep dry-run on until the configuration and test workflow have been reviewed.
- The application uses the `Applicants`, `Templates`, `Config`, and `EmailLog` tabs. Google Form responses need to be copied/mapped into `Applicants`; the app does not automatically turn a separate Form Responses tab into applicant records.

> **Important dry-run behavior in this version:** dry-run prevents email delivery, but a successful simulated send is still written to `EmailLog` and advances the applicant to `SENT` with a `sent_at` value. Dry-run entries also count toward the app-side daily cap. Use a dedicated test applicant; do not use a real candidate row to rehearse a send.

## Navigation at a glance

| Screen | Use it for |
|---|---|
| **Inbox** | Candidate list, pipeline actions, live Zoho conversations, and one-person composing/replies. |
| **Templates** | Generate, preview, activate/deactivate templates, and configure template attachments. |
| **Console** | Run preflight checks and review the recent send log. |
| **Settings** | Toggle drafting/sending and dry-run; inspect other Config values. |

## 1. Inbox and candidate list

### Find and select candidates

1. Open **Inbox**. The list is read from the `Applicants` tab.
2. Use search to find candidates by name, email, applicant ID, role, or notes.
3. Combine the role, stage, and category filters as needed.
4. Use **Group by** to organize the list by role, stage, or category.
5. Select a candidate to open their details and conversation area. Tick the checkbox beside rows to prepare a bulk action.
6. If someone edited the spreadsheet or added records outside the app, click **Refresh from sheet** to read the latest data.

The summary cards show total applicants, applicants awaiting draft or approval, ready-to-send applicants, sent applicants, and rows needing attention. Duplicate applicant IDs and email addresses are highlighted. Fix duplicates in the sheet and refresh before taking action; duplicate IDs are especially risky because actions resolve the first matching row.

### Add an applicant

1. Click **+ New**.
2. Enter the candidate’s email (required), and add their name, role, and category.
3. Submit **Add candidate**. The app adds a row to `Applicants` at stage `NEW`.

If the email already exists, the app opens the existing record rather than creating another one. Keep role spelling consistent because role filters and template matching use the sheet values.

The current form also has a notes field, but the current server action does not persist that field. If you need notes on a newly added applicant, add them directly to that row in the `Applicants` sheet, then refresh the Inbox.

### Edit an email or category

1. Select the candidate.
2. Edit **Email** or **Category** in the candidate details.
3. Click the matching **Save** button.

The app validates email syntax and refuses an email address already assigned to another applicant. Other applicant fields should be edited in the `Applicants` sheet; refresh the Inbox afterwards.

## 2. Draft and send to a group

The bulk workflow is intentionally staged:

`NEW → DRAFTED → APPROVED → SENT`

1. Tick only the intended applicants. Check each email address and resolve duplicate warnings.
2. Click **Generate drafts**. The app selects the best active template match and writes the draft into the applicant row. A template containing `{{ai_body}}` uses Groq to personalize the body; static templates do not require that per-applicant body-generation call.
3. Select drafted applicants and click **Approve** only after a human has reviewed their drafts. **Unapprove** moves approved rows back to `DRAFTED` for further review.
4. Confirm the banner at the top of Inbox. With dry-run on, **Dry-run send** logs a simulation but does not email anyone; note the state-changing behavior described above.
5. For real delivery, the administrator must deliberately turn dry-run off and enable sending in Settings. Review the selected recipients in the send confirmation and click to proceed.
6. Check **Console → Email log** and the Zoho Sent folder after real sends. If a send times out or the app reports a follow-up Sheets error, check Zoho Sent before retrying to avoid duplicates.

Only approved rows can be sent. The app blocks unresolved `{{merge_fields}}`, invalid email addresses, already-sent rows, disabled sending, missing live Zoho configuration, and batches beyond the configured app-side cap.

## 3. Work with one candidate and their Zoho conversation

1. Select a candidate in Inbox. The app requests message summaries from Zoho for the candidate’s email address.
2. Select a conversation to load its full messages. The panel may show a loading indicator while Zoho responds.
3. Read the conversation in the panel. Message bodies are loaded on demand and are not written to Google Sheets by this app.
4. To draft a message, enter what it should say in plain English. Optionally select an active template as a style reference.
5. Click **Write with AI**, or click **Use template as-is** to fill from the chosen template without an AI drafting call.
6. Review and edit the subject and HTML body. Use **Preview** to inspect the message. Remove unresolved `{{fields}}` before sending.
7. Optionally attach local files (up to 15 MiB total), then click **Send** and confirm the delivery state.

When a conversation is open and the latest candidate message is identified, a real send can be made as a reply in that thread if no attachments are included. If attachments are included, the app sends a new message rather than using the thread-reply API path. Drafting and sending remain human-initiated; the app does not monitor replies in the background or automatically change a candidate to `REPLIED`.

## 4. Templates

1. Open **Templates**.
2. To generate a new template, enter its purpose and tone; optionally choose a role and add extra instructions, then click **Generate**.
3. AI-generated templates are saved **inactive**. Click **Preview**, inspect the content and branding, then click **Activate** when it is ready. Deactivate old templates so they are not offered for use.
4. A template may be entered/edited directly in the `Templates` sheet. Use merge fields such as `{{first_name}}`, `{{job_role}}`, and company branding values. Keep exactly one default template for fallback matching.
5. To attach a file to a template, open its **Preview**, enter a URL reachable without signing in and an optional filename, then **Save attachment**. The file is fetched when sending; it must remain reachable and within the 15 MiB limit.

Template selection prefers the most specific active match: role plus category, then role, then the default. Static templates do not use model quota for each bulk draft. Templates using `{{ai_body}}` do.

## 5. Console and preflight

1. Open **Console** and click **Run preflight**.
2. Read each check and its fix guidance. Preflight checks credentials, expected Config keys, duplicates, and email syntax. When Zoho is configured it makes a mailbox check; it does not send email or write conversation bodies.
3. Resolve blocking problems before enabling live sending. Duplicate email and some dry-run/Zoho checks may be warnings depending on the current state; read the displayed detail.
4. Use **Email log** to inspect recent attempts, their result, dry-run status, and provider message ID. The screen shows up to the latest 100 entries.

## 6. Settings and branding

1. Open **Settings**.
2. Use the Drafting and Sending switches to enable or disable those actions. These switches take effect without a redeploy.
3. Keep **Dry run ON** while testing. **Go live** turns it off after confirmation; then approved drafts can reach real candidates if Sending is also enabled and Zoho is configured.
4. Other configuration values are shown on this screen but are edited in the `Config` tab of Google Sheets. This includes company name, HR name/signature, reply-to/company email, phone/incubator details, categories, `batch_size`, `send_daily_cap`, and `company_logo_url`.
5. For the logo, the default is the dashboard’s public `/brand/logo.png`. Set `company_logo_url` only when using a different public, unauthenticated logo URL. Preview a template and send a controlled test to verify the image loads in the recipient’s email client.

## Data boundaries and reminders

- `Applicants` is the roster and retains the latest applicant draft/sent snapshot and stage.
- `Templates` stores reusable message templates and attachment links.
- `Config` stores operational switches and branding values.
- `EmailLog` is the send-attempt audit trail. Do not manually edit its rows.
- Full Zoho conversation bodies are retrieved live when opened; they are not copied into Sheets by this version.
- The dashboard reads full sheet tabs and there is no automatic background intake, reply polling, resume analysis, or Gemini failover in this version.
- Avoid putting sensitive personal data in notes unless needed for the hiring task. Review every AI-generated message before sending.
