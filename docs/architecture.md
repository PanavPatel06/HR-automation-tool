# Architecture

How the pieces fit, and the reasoning behind the choices that are not obvious.

```
  Google Form ──┐
                ├──▶  Google Sheets  ◀────────────┐
  Manual entry ─┘     (source of truth)           │
                             ▲                    │
                             │ read/write         │ read
              ┌──────────────┴───────────┐        │
              │           n8n            │        │
              │  WF-00 Preflight         │        │
              │  WF-01 Intake            │        │
              │  WF-02 Draft ──▶ Groq ──▶│        │
              │        └─fallback─▶ Gemini        │
              │  WF-03 Send  ──▶ Gmail ──▶ candidate
              │  WF-04 Replies ◀── Gmail ◀────────┘ (reply)
              │  WF-05 Follow-up flagging          │
              │  WF-90 Error handler               │
              │  WF-91 Heartbeat                   │
              └──────────▲─────────────────────────┘
                         │ signed webhook (HMAC)
              ┌──────────┴───────────┐
              │  Next.js dashboard   │
              │  (Vercel free tier)  │
              └──────────────────────┘
```

---

## The three actors

**Google Sheets is the source of truth.** Not a cache, not a mirror. If both the
dashboard and n8n are down, HR can still see every candidate and work by hand.
That property is worth more than the performance a real database would buy at
this scale.

**n8n owns every side effect.** All mail, all model calls, all secrets. Nothing
else can send an email.

**The dashboard is a view plus a trigger.** It reads Sheets and posts signed
webhooks. It holds no API keys for Groq, Gemini, or Gmail.

The split means an attacker who fully compromises the dashboard still cannot
email a candidate directly — they can only ask n8n to, and n8n re-validates
every rule.

---

## Where logic lives

The hard constraint: **n8n Code nodes cannot `require` local files.** The usual
consequence is that all workflow logic ends up as untestable strings inside
workflow JSON.

Instead:

```
n8n/src/lib/*.js     ordinary modules — what tests/ exercises
n8n/src/nodes/*.js   node bodies, declaring deps with `// @requires`
        │
        │  scripts/build-workflows.mjs
        ▼
n8n/workflows/*.json generated; every Code node carries a provenance header
```

`tests/bundle.test.js` then runs the **generated** bodies against fake n8n
globals, so bundling, `$('Node')` reads and branch wiring are covered too — not
just the pure functions.

`npm run check:workflows` fails the build if committed JSON is stale, if a Code
node reads a node that does not exist or is not upstream of it, if a node is
unreachable from a trigger, if a webhook lacks signature verification, or if a
generated body does not parse.

---

## The workflow shape

Every workflow has the same skeleton:

```
trigger → read what you need → ONE planning node → fan out to emit-* → sheet writes
```

The planning node is the only place judgement happens, and it is a thin wrapper
around tested library code. It returns a single item carrying named row arrays:

```js
{ applicant_rows: [...], error_rows: [...], runlog_rows: [...], ... }
```

Each `emit-*` node reads one of those arrays and turns it into sheet items.

This buys three things. Branches contain no logic, so nothing important is
hidden in n8n's UI. Emitting an empty array cleanly no-ops a branch — which is
how a dry run skips Gmail entirely, without a conditional. And every workflow
returns the same envelope shape, so the dashboard renders any of them without
new code.

---

## The AI layer

One entry point, `AiRouter`, for every model call. Its job, in priority order:

1. **Never let a quota error corrupt a row.** Exhaustion *parks* — the batch
   stops, rows stay untouched and retryable, work resumes at the window reset.
2. **Fail over Groq → Gemini**, and record `W-AI-FAILOVER` so degradation is
   never silent.
3. **Check the budget before dispatch**, so an exhausted model is skipped rather
   than earning a 429.

All I/O is injected, so the whole thing is unit-tested with no network and no
real clock.

### Why the ledger lives in n8n's static store

Quota state uses `$getWorkflowStaticData('global')`: it survives restarts and
needs no sheet round-trip on the hot path. A snapshot is written to the Quota tab
after each batch purely so the dashboard can display it.

### Why TPD is the constraint

Free-tier throughput is bounded by **tokens per day**, not requests per minute.
That is why templates opt into AI with `{{ai_body}}`: static templates cost
nothing, so quota is spent only where personalisation matters. And why Gemini is
worth configuring — it is a separate quota pool, so it is genuine redundancy
rather than a retry.

---

## The stage machine

```
NEW ──▶ DRAFTED ──▶ APPROVED ──▶ SENT ──▶ REPLIED ──▶ CLOSED
 │         │            │          │
 └─────────┴────────────┴──────────┴────▶ FAILED ──▶ (back to origin on retry)
```

`DRAFTED → SENT` is **not** a legal transition. Approval is a mandatory, separate,
human-only step, enforced in three places: the transition table, `planSends()`,
and the dashboard's action route. Three checks because it is the rule that
matters most.

The dashboard duplicates the table in `dashboard/lib/contract.ts` (it deploys
from its own directory and cannot import the n8n library), and
`tests/contract-parity.test.js` fails the build if the two ever disagree.

---

## Trust boundaries

| Boundary | Control |
|---|---|
| Browser → dashboard | Signed session cookie, HMAC-verified server-side |
| Dashboard → n8n | HMAC over a **canonically serialised** body plus timestamp, 5-minute replay window |
| n8n → Google | Service account scoped to one spreadsheet |
| n8n → Gmail | OAuth on the HR mailbox |
| Model output → candidate | Schema check, then template render, then HTML validation, then human approval |

Signing canonicalises JSON with recursively sorted keys, because the dashboard
serialises an object and n8n parses and re-serialises it — without that, a
key-order difference across the hop would look like tampering.

That last row is the important one: **four gates between what a model writes and
what a candidate reads**, the last of which is a person.

---

## What is deliberately not automated

- **Approval.** Every email is read by a human first.
- **Rejection.** No candidate is auto-rejected. V2 scoring will rank, not decide.
- **Follow-ups.** V1 flags silence; it does not nag.
- **Reply outcomes.** Classification sorts the inbox. Nothing acts on it
  automatically, and low-confidence results escalate rather than guess.

Each of these is cheap to automate and expensive to get wrong. A wrongly
auto-rejected strong candidate is an invisible loss — no error, no alert, just a
worse hire six weeks later.

---

## What V2 adds

V2 inserts two stages in front of the existing pipeline and reuses everything
else:

```
NEW ──▶ PARSED ──▶ SCORED ──▶ SHORTLISTED ──▶ DRAFTED ──▶ … (V1 unchanged)
```

The columns are already declared in `n8n/src/lib/schema.js` marked `v2: true`,
and the bootstrap creates them with `--v2`. V2 columns only ever *append*, so V1
column positions never move. See [PLAN.md](../PLAN.md) §6.
