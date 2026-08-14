# n8n workflows

Workflow JSON in `workflows/` is **generated**. Do not edit it by hand, and do
not edit Code nodes inside the n8n editor — the next build overwrites both.

```
n8n/src/lib/     tested library code        <- edit here
n8n/src/nodes/   Code-node bodies           <- edit here
n8n/workflows/   generated JSON             <- never edit
```

## Making a change

```bash
$EDITOR n8n/src/lib/pipeline.js     # or src/nodes/*.js
npm test                            # library + bundled-node tests
npm run build:workflows             # regenerate JSON
```

Then re-import the changed workflow in n8n (**Workflows → ⋯ → Import from File**).

`npm run check:workflows` fails if the committed JSON is stale, if a Code node
reads a `$('Node')` that does not exist or is not upstream, if a node is
unreachable, if a webhook lacks signature verification, or if a generated body
does not parse. It runs in CI.

## Why the code is bundled

n8n Code nodes cannot `require` local files, which normally forces workflow
logic to live as untestable strings inside JSON. Instead the logic lives in
real modules that `tests/` exercises directly, and `scripts/build-workflows.mjs`
inlines them into each node body. Every generated file carries a header saying
where it came from.

## Importing

```bash
# On the n8n host, after `docker compose up -d`:
docker compose exec n8n n8n import:workflow --separate --input=/workflows
docker compose restart n8n
```

Or one at a time through the editor UI. After importing, for each workflow:

1. Open it and select the credential on every Google Sheets and Gmail node
   (the JSON references them by name; n8n needs you to bind them once).
2. Set **Settings → Error Workflow → WF-90 Error Handler**.
3. Activate it. Leave **WF-03 Send** inactive until you have run a dry run.

## Workflows

| ID | Trigger | Purpose |
|---|---|---|
| WF-00 | manual / webhook | Preflight: proves every credential and env var works. Writes nothing. |
| WF-01 | every 2 min | Intake: validates new Applicants rows. |
| WF-02 | webhook `/draft` | Draft generation (the only workflow that spends model quota). |
| WF-02b | webhook `/template-generate` | Generates an HTML template from a brief. Saved inactive. |
| WF-03 | webhook `/send` | Sending. Refuses anything not APPROVED with a complete draft. |
| WF-04 | Gmail poll, 5 min | Reply matching and intent classification. |
| WF-05 | daily 09:00 | Flags silent candidates. Never sends. Off by default. |
| WF-90 | error trigger | Catches every unhandled failure. Set as Error Workflow everywhere. |
| WF-91 | every 10 min | Heartbeat, so "n8n stopped running" is detectable. |
