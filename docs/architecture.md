# Architecture

How the pieces fit, and the reasoning behind the choices that are not obvious.

```
  Google Form ──┐
                ├──▶  Google Sheets  ◀──────────────┐
  Manual entry ─┘     (source of truth)             │
                             ▲                       │ read
                             │ read/write            │
              ┌──────────────┴────────────────────┐  │
              │        Next.js dashboard           │  │
              │        (Vercel free tier)          │  │
              │  Draft   ──▶ Groq                  │  │
              │  Send    ──▶ Gmail ───▶ candidate ─┘  │
              │  Inbox   ◀── Gmail ◀── (reply, on demand)
              │  Preflight, approve, settings — all in-process
              └─────────────────────────────────────┘
```

---

## The two actors

**Google Sheets is the source of truth.** Not a cache, not a mirror. If the
dashboard is down, HR can still see every candidate and work by hand in the
sheet directly. That property is worth more than the performance a real
database would buy at this scale.

**The dashboard is the whole backend.** It reads and writes Sheets, calls
Groq to draft, and calls Gmail to send — all inside the same request a
person triggers by clicking a button. There is no separate service holding
secrets or running on a schedule; every side effect happens because a human
clicked something, in the request that click made.

This is a deliberate simplification from an earlier design that split
"trigger" (dashboard) from "does the side effect" (a workflow engine) across
two deployed services connected by a signed webhook. That split earns its
keep once there's scheduled, unattended work — polling a mailbox, watching
for new form rows — which V1 does not have: every action here is a person
looking at a screen and clicking a button, so the two-service split was
pure overhead. See [Known limitations](../README.md#known-limitations) for
what that trade gives up (no automated intake, no scheduled reply polling).

---

## Where logic lives

```
lib/schema.js              the sheet contract: tabs, columns, the stage machine
dashboard/lib/contract.ts  the same contract, mirrored by hand (see below)
dashboard/lib/template.ts  merge-field rendering, HTML validation, template selection
dashboard/lib/draft.ts     batch selection + the Groq prompt/schema gate for Draft
dashboard/lib/groq.ts      the Groq client
dashboard/lib/gmail.ts     the Gmail client
dashboard/app/api/action/route.ts   every mutating action — draft, send, approve, ...
```

`lib/schema.js` at the repo root is read by `scripts/bootstrap-sheets.mjs`
and the tests. The dashboard deploys from `dashboard/` alone on Vercel and
cannot import outside that directory, so `dashboard/lib/contract.ts`
duplicates the same tab/column/stage definitions by hand.
`tests/contract-parity.test.js` fails the build if the two ever drift apart.

---

## The stage machine

```
NEW ──▶ DRAFTED ──▶ APPROVED ──▶ SENT ──▶ REPLIED ──▶ CLOSED
 │         │            │          │
 └─────────┴────────────┴──────────┴────▶ FAILED ──▶ (back to origin on retry)
```

`DRAFTED → SENT` is **not** a legal transition. Approval is a mandatory,
separate, human-only step, enforced in two places: `ACTIONABLE` in
`dashboard/lib/contract.ts` (what the UI will even attempt) and the `send`
action's own per-row stage check in `route.ts` (what actually runs, even if
someone calls the API directly). Two checks because it is the rule that
matters most.

---

## The AI layer

`lib/groq.ts` is the dashboard's only model provider: one function, one
free-tier key, no failover and no quota ledger. That's a real simplification
from a design with a Groq→Gemini failover chain and a persisted token-bucket
ledger — worth it at V1's volume (a few dozen drafts a day), and Groq
returns a plain rate-limit error if it isn't, rather than failing silently.
Add a second provider here if that ever actually bites.

Templates opt into AI per-field with `{{ai_body}}`: a template without it
renders deterministically and costs zero tokens, so quota is spent only
where personalisation matters — see `usesAi()` in `dashboard/lib/draft.ts`.

Every generated subject/body is re-rendered through the same merge-field
gate a hand-written template goes through (`renderEmail()` in
`dashboard/lib/template.ts`) before it's shown or sent, so a model that
echoes a literal `{{field}}` back gets caught rather than reaching a
candidate.

---

## Trust boundaries

| Boundary | Control |
|---|---|
| Browser → dashboard | Signed session cookie, HMAC-verified server-side |
| Dashboard → Google Sheets | Service account scoped to one spreadsheet |
| Dashboard → Gmail | OAuth on the HR mailbox (optional; unset and sending stays logged-only) |
| Model output → candidate | Schema check, then template render, then HTML validation, then human approval |

The last row is the important one: **three gates between what a model
writes and what a candidate reads**, the last of which is a person.

---

## What is deliberately not automated

- **Approval.** Every email is read by a human first.
- **Rejection.** No candidate is auto-rejected. V2 scoring will rank, not decide.
- **Follow-ups.** Nothing nags a silent candidate automatically.
- **Reply classification and intake normalisation.** Both were background
  jobs in an earlier design; for now, reading a reply and adding an
  applicant are both direct, manual actions in the dashboard — see
  [Known limitations](../README.md#known-limitations).

Each of these is cheap to automate and expensive to get wrong. A wrongly
auto-rejected strong candidate is an invisible loss — no error, no alert,
just a worse hire six weeks later.

---

## What V2 adds

V2 inserts two stages in front of the existing pipeline and reuses everything
else:

```
NEW ──▶ PARSED ──▶ SCORED ──▶ SHORTLISTED ──▶ DRAFTED ──▶ … (V1 unchanged)
```

The columns are already declared in `lib/schema.js` marked `v2: true`, and
the bootstrap creates them with `--v2`. V2 columns only ever *append*, so V1
column positions never move. See [PLAN.md](../PLAN.md) §6.
