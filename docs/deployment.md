# Deployment

Start to finish, roughly 40 minutes. Order matters — each step verifies the one
before it.

At the end you will have: a spreadsheet with 9 tabs, n8n running on HTTPS with 9
workflows, and a dashboard on Vercel.

---

## 1. A server for n8n

n8n must run somewhere always-on. Webhooks and polling triggers both need it.

### Recommended: Oracle Cloud Always Free

The only genuinely free always-on option — 4 ARM cores and 24 GB RAM, no expiry.
A card is required for identity verification but is not charged.

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com). Approval sometimes
   takes a few hours, and some regions run out of ARM capacity — if creation
   fails with "out of host capacity", try a different availability domain or
   retry later.
2. Create a **VM.Standard.A1.Flex** instance: 2 OCPU / 12 GB is plenty. Image:
   Ubuntu 22.04. Save the SSH key.
3. **Networking → open ports 80 and 443.** Two places, both needed:
   - the subnet's security list (add ingress rules for 0.0.0.0/0 on 80 and 443);
   - the host firewall:
     ```bash
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```
     Forgetting the host firewall is the most common reason TLS issuance hangs.
4. Install Docker:
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER && exit   # log back in
   ```

### Alternative: Render free tier

Works, with one real caveat: free services **sleep after ~15 minutes idle**.
Webhooks wake them (with a cold-start delay), but **scheduled triggers are
missed while asleep** — so WF-01 intake, WF-05 follow-ups and WF-91 heartbeat
become unreliable.

If you go this route, drive the schedules externally: a free
[cron-job.org](https://cron-job.org) job or a GitHub Actions `schedule:` that
POSTs to a webhook, instead of n8n's own schedule triggers.

### A domain name

Caddy needs a real hostname for TLS. A free subdomain from
[DuckDNS](https://duckdns.org) or similar works fine. Point an A record at the
server's public IP and wait for it to resolve before starting Caddy.

---

## 2. Google: spreadsheet, service account, Gmail

### 2.1 The spreadsheet

Create a blank Google Sheet. From its URL:

```
https://docs.google.com/spreadsheets/d/1AbC...XyZ/edit
                                      └──── SHEET_ID ────┘
```

### 2.2 Service account

1. [Google Cloud Console](https://console.cloud.google.com) → create a project.
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → Credentials → Create credentials → Service account.**
   Name it `hr-automation`. No roles needed — access comes from sharing the
   sheet, not from IAM.
4. Open the service account → **Keys → Add key → Create new key → JSON**.
   Download it. This file is a credential; treat it like a password.
5. Copy the service account's email (`hr-automation@<project>.iam.gserviceaccount.com`).

### 2.3 Share the sheet — do not skip this

Open the spreadsheet → **Share** → paste the service account email → **Editor** →
Send.

Every `E-SHEET-PERM` traces back to this step.

### 2.4 Create the tabs

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

### 2.5 The sending mailbox

Use a real Google account HR owns — replies land in the same inbox, which is how
reply tracking works for free. A dedicated `hiring@` account is tidier than a
personal one.

---

## 3. API keys

| Key | Where | Notes |
|---|---|---|
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) | Free. Primary provider. |
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Free. **Strongly recommended** — it is a separate quota pool, so it is genuine redundancy, not just a retry. |

While you are in each console, note the current free-tier rate limits and put
the real numbers into `n8n/src/lib/ai-router.js` (`MODELS`). The values shipped
are documented placeholders.

---

## 4. n8n

### 4.1 Start it

```bash
# on the server
git clone <your-repo-url> hr-automation
cd hr-automation/n8n
cp .env.example .env
$EDITOR .env
```

Generate the three secrets:

```bash
openssl rand -hex 32   # N8N_ENCRYPTION_KEY  — back this up; changing it orphans every credential
openssl rand -hex 24   # POSTGRES_PASSWORD
openssl rand -hex 32   # N8N_WEBHOOK_SECRET  — the dashboard needs this exact value
```

```bash
docker compose up -d
docker compose logs -f n8n     # watch for "Editor is now accessible"
```

Visit `https://your-host`. Caddy issues a certificate on first request; if it
hangs, ports 80/443 are not actually open (see §1.3).

### 4.2 Credentials

In the n8n editor, **Credentials → Add credential**:

1. **Google Service Account** — name it exactly `HR Sheets Service Account`.
   Paste `client_email` and the **entire** `private_key` from the JSON,
   including `-----BEGIN PRIVATE KEY-----` and the `\n` sequences.
2. **Gmail OAuth2** — name it exactly `HR Gmail`. This needs a Google OAuth
   client:
   - Cloud Console → **Credentials → Create credentials → OAuth client ID → Web application**
   - Authorised redirect URI: `https://your-host/rest/oauth2-credential/callback`
   - Enable the **Gmail API** in the same project
   - Paste the client id/secret into n8n and click **Connect**, signing in as the
     HR mailbox

The names matter: the workflow JSON references credentials by name.

### 4.3 Import the workflows

```bash
docker compose exec n8n n8n import:workflow --separate --input=/workflows
docker compose restart n8n
```

Or **Workflows → ⋯ → Import from File** for each file in `n8n/workflows/`.

### 4.4 Wire each workflow

For every imported workflow:

1. Open it. Any Google Sheets or Gmail node showing a credential warning: select
   the credential from the dropdown.
2. **Settings → Error Workflow → `WF-90 Error Handler`**. This is what routes
   unhandled failures to the Errors tab.
3. **Save**, then **Activate** — except **WF-03 Send**, which stays inactive
   until after your first dry run.

### 4.5 Preflight

Open **WF-00 Preflight** and click **Test workflow**. It checks every
environment variable, the Sheets credential, the Config tab contract, and both
model providers, and writes nothing.

Fix everything it reports before continuing. Each failed check includes its own
fix text.

---

## 5. Dashboard

### 5.1 Local

```bash
cd dashboard
cp .env.example .env.local
$EDITOR .env.local
npm install
npm run dev
```

```
SHEET_ID=                     # same as before
GOOGLE_SERVICE_ACCOUNT_JSON=  # the WHOLE json file, on one line, in single quotes
N8N_BASE_URL=https://your-host        # no trailing slash
N8N_WEBHOOK_SECRET=           # EXACTLY the value from n8n/.env
DASHBOARD_PASSWORD=           # what the HR team will type
SESSION_SECRET=               # openssl rand -hex 32
```

### 5.2 Vercel

1. Import the repo at [vercel.com/new](https://vercel.com/new).
2. **Root Directory → `dashboard`.** Without this the build fails.
3. Add the six environment variables above under **Settings → Environment Variables**.
4. Deploy.

For `GOOGLE_SERVICE_ACCOUNT_JSON` paste the file contents directly into the
value box — no quotes, no escaping. Vercel handles the newlines.

---

## 6. Verify end to end

Work through this in order. Each step proves a different link.

| # | Do | Expect |
|---|---|---|
| 1 | Dashboard → **Console** → **Run preflight** | All checks green. Proves dashboard→n8n signing, n8n→Sheets, n8n→Groq. |
| 2 | Add a row to Applicants: name, email, job_role | Within 2 min it appears as **NEW**. Proves WF-01. |
| 3 | Add a row with a nonsense `job_role` | Appears **blocked** with `E-INTAKE-ROLE`. Proves failures are visible, not silent. |
| 4 | Select a valid row → **Generate drafts** | Stage becomes **DRAFTED**. Proves WF-02 and the model path. |
| 5 | **Preview** | The rendered email, no `{{fields}}` left. |
| 6 | **Approve** | Stage **APPROVED**. |
| 7 | Settings → turn on *Sending*. Keep **dry run ON**. Select → **Dry-run send** | EmailLog gets a `dry-run` row. **No email arrives.** Proves WF-03 without risk. |
| 8 | Settings → **Go live** → send to your own address | The email arrives. `thread_id` is populated. |
| 9 | Reply to it from that address | Within 5 min it appears on **Replies**, classified. Proves WF-04. |

If any step fails, the code on the Console page names the cause.
[docs/runbook.md](runbook.md) is organised by symptom.

---

## 7. Keeping it running

**Uptime.** Add a free [UptimeRobot](https://uptimerobot.com) monitor on
`https://your-host/healthz` at 5-minute intervals. On Render this also keeps the
service awake.

**Backups.** The spreadsheet is the data, and Google versions it automatically.
Also back up:
- `N8N_ENCRYPTION_KEY` — without it, saved credentials are unrecoverable
- the service-account JSON
- `n8n/.env`

**Updating n8n.**

```bash
cd hr-automation/n8n
docker compose pull && docker compose up -d
```

Then re-run WF-00 Preflight. Node parameter shapes occasionally change between
major n8n versions.

**Changing workflow logic.** Edit `n8n/src/lib/` or `n8n/src/nodes/`, then:

```bash
npm run verify              # tests + graph validation
npm run build:workflows
```

Re-import the changed workflows. Never edit a Code node in the n8n editor — the
next build overwrites it.

---

## Costs

| | |
|---|---|
| Oracle Cloud Always Free VM | $0 (card verified, not charged) |
| Vercel Hobby | $0 |
| Google Sheets + Drive | $0 |
| Groq + Gemini free tiers | $0 |
| Gmail sending | $0 (~500/day) |
| Domain | $0 with DuckDNS, or ~$10/yr for your own |
