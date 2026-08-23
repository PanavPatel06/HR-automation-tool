# Deployment

Start to finish, roughly 15 minutes. Order matters — each step verifies the
one before it. There is one deployable piece: the dashboard. Sheets needs no
deployment of its own — it's already live the moment you create it.

---

## 1. Google: spreadsheet, service account, Gmail

### 1.1 The spreadsheet

Create a blank Google Sheet. From its URL:

```
https://docs.google.com/spreadsheets/d/1AbC...XyZ/edit
                                      └──── SHEET_ID ────┘
```

### 1.2 Service account

1. [Google Cloud Console](https://console.cloud.google.com) → create a project.
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → Credentials → Create credentials → Service account.**
   Name it `hr-automation`. No roles needed — access comes from sharing the
   sheet, not from IAM.
4. Open the service account → **Keys → Add key → Create new key → JSON**.
   Download it. This file is a credential; treat it like a password.
5. Copy the service account's email (`hr-automation@<project>.iam.gserviceaccount.com`).

### 1.3 Share the sheet — do not skip this

Open the spreadsheet → **Share** → paste the service account email → **Editor** →
Send.

Every `E-SHEET-PERM` traces back to this step.

### 1.4 Create the tabs

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

Verify at any point with `npm run bootstrap:sheets -- --check`.

### 1.5 The sending mailbox

Use a real Google account HR owns — replies land in the same inbox. A
dedicated `hiring@` account is tidier than a personal one.

### 1.6 API key

| Key | Where | Notes |
|---|---|---|
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) | Free. The dashboard's only model provider. |

---

## 2. Dashboard

The dashboard is a standard Next.js app — deploy it anywhere that runs
Node 20+. Two options below: Render (free, one blueprint file, what this repo
ships pre-configured for) and Vercel (also free, zero-config for Next.js).
Either works; there is nothing else to run alongside it.

### 2.1 Local, first

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

### 2.2 Render

This repo ships `render.yaml` at its root, so Render can build the whole
thing from a **Blueprint** without any manual service configuration:

1. Push the repo to GitHub (or GitLab).
2. [dashboard.render.com/blueprints](https://dashboard.render.com/blueprints) →
   **New Blueprint Instance** → pick the repo. Render reads `render.yaml`
   and creates one free web service rooted at `dashboard/`.
3. It will prompt for the env vars marked `sync: false` in `render.yaml` —
   paste in the same values as `.env.local` above (`GOOGLE_SERVICE_ACCOUNT_JSON`
   pastes as raw JSON, no extra quoting needed).
4. **Apply** — it builds with `npm install && npm run build` and starts with
   `next start -p $PORT` (Render assigns the port; the blueprint already
   passes it through).

Free-tier Render services **spin down after ~15 minutes idle** and take a
few seconds to wake on the next request — fine here, since every action in
this app is triggered by a person clicking something, not a background
schedule waiting to be missed.

If you'd rather configure it by hand instead of the blueprint: **New → Web
Service** → same repo → **Root Directory: `dashboard`** → **Build Command:
`npm install && npm run build`** → **Start Command: `npm start -- -p $PORT`**
→ add the same env vars → **Create Web Service**.

### 2.3 Vercel (alternative)

1. Import the repo at [vercel.com/new](https://vercel.com/new).
2. **Root Directory → `dashboard`.** Without this the build fails.
3. Add the same five environment variables under **Settings → Environment Variables**.
4. Deploy.

For `GOOGLE_SERVICE_ACCOUNT_JSON` paste the file contents directly into the
value box — no quotes, no escaping. Vercel handles the newlines.

---

## 3. Verify end to end

Work through this in order against your deployed URL.

| # | Do | Expect |
|---|---|---|
| 1 | Dashboard → **Console** → **Run preflight** | All checks green (or only the `Gmail configured` warning if you haven't set up Gmail). |
| 2 | Add a row to Applicants: `applicant_id`, `name`, `email`, `job_role`, `stage`=`NEW`, `status`=`ok` | Appears on the dashboard as **NEW**. |
| 3 | Select it → **Draft** | Stage becomes **DRAFTED**, with a rendered subject/body and no `{{fields}}` left. |
| 4 | **Approve** | Stage **APPROVED**. |
| 5 | Settings → turn on *Sending*. Keep **dry run ON**. Select → **Send** | EmailLog gets a `dry_run=true` row. **No email arrives.** |
| 6 | Settings → **Go live** → send to your own address | The email arrives. `thread_id` is populated. |

If any step fails, the code on the Console page names the cause.
[docs/runbook.md](runbook.md) is organised by symptom.

---

## 4. Keeping it running

**Backups.** The spreadsheet is the data, and Google versions it
automatically. Also back up the service-account JSON and your `.env`/env-var
values somewhere outside the deploy platform.

**Uptime, if you care about cold starts.** A free
[UptimeRobot](https://uptimerobot.com) monitor hitting the dashboard URL
every few minutes keeps a free Render service from spinning down between
uses.

---

## Costs

| | |
|---|---|
| Render free tier / Vercel Hobby | $0 |
| Google Sheets + Drive | $0 |
| Groq free tier | $0 |
| Gmail sending | $0 (~500/day) |
