# Learning this codebase — a path from basic Python

You know Python syntax, loops and functions. This project is JavaScript. This
document gets you from there to confidently changing and extending it.

**It is not a JavaScript tutorial.** Every concept here is taught with real code
from *this repo*, in the order you will actually meet it. Generic tutorials give
you generic knowledge; you need to be able to read [`n8n/src/lib/pipeline.js`](n8n/src/lib/pipeline.js)
by the end of the month, and that is what this is aimed at.

## How to use it

Work top to bottom. Do not skip to Part 5 because V2 sounds interesting — the
async chapter is genuinely the hard one, and everything in V2 depends on it.

| Part | What | Rough time |
|---|---|---|
| 0 | Get the feedback loop running | 90 minutes |
| 1 | Python → JavaScript syntax map | 3–4 hours |
| 2 | The five things Python basics didn't cover | 1 week, part-time |
| 3 | Guided tour of this codebase | 1 week, part-time |
| 4 | Exercise ladder — 12 real changes, easy to hard | 2–3 weeks |
| 5 | TypeScript, only the parts the dashboard needs | 3–4 hours |
| 6 | Building V2 | see the milestone plan |

Honest estimate: **4–6 weeks of evenings** before V2 feels comfortable. You will
be able to make small real changes after week one.

---

# Part 0 — The feedback loop (do this first)

Nothing else matters until you can run the tests and watch them fail.

```bash
cd "path/to/hr automation"
npm install
npm test
```

You should see 105 passing tests. Now break one on purpose:

Open [`n8n/src/lib/intake.js`](n8n/src/lib/intake.js), find `normaliseEmail`, and
delete `.toLowerCase()`. Run `npm test` again.

```
✖ accepts and normalises a good row
  + actual - expected
  + 'ASHA@example.com'
  - 'asha@example.com'
```

That is your whole workflow. **Change code → `npm test` → read the failure.**
Put the `.toLowerCase()` back.

### Run one file at a time

Once you have 105 tests, waiting for all of them gets tedious:

```bash
node --test tests/intake.test.js          # just this file
node --test --test-name-pattern="email"   # just tests whose name contains "email"
```

### The REPL — your equivalent of `python3` at a prompt

```bash
node
> const { normalisePhone } = require('./n8n/src/lib/intake.js')
> normalisePhone(' +91 (98765) 43210 ')
'+919876543210'
```

Use this constantly. When you do not understand what a line does, paste it in
and look. `.exit` or Ctrl-D to leave.

### Printing things

`print()` → `console.log()`. It takes multiple arguments like Python's print:

```js
console.log('applicant:', applicant.name, 'stage:', applicant.stage);
```

For objects, `console.log(JSON.stringify(obj, null, 2))` gives you readable
output — the plain version truncates nested objects.

---

# Part 1 — Python → JavaScript, side by side

Everything here is a real pattern from this repo.

## Variables

```python
name = "Asha"          # can be reassigned
ROLES = ["a", "b"]     # convention says don't reassign
```
```js
let name = 'Asha';        // can be reassigned
const ROLES = ['a', 'b']; // cannot be reassigned
```

**Rule for this codebase: use `const` unless you must reassign, then `let`.**
Never `var` — it is the old broken one. Note `const` on an array or object stops
you *rebinding the name*, not mutating the contents: `ROLES.push('c')` is still
legal. That trips up everyone.

## Functions

```python
def normalise_email(raw):
    return str(raw or '').strip().lower()
```
```js
function normaliseEmail(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}
```

Two differences beyond the braces: JavaScript has no `snake_case` convention —
this codebase uses `camelCase` for functions and variables, `PascalCase` for
classes, `SCREAMING_CASE` for constants. And there is no implicit return; you
must write `return`.

### Arrow functions

The other function syntax, used everywhere for short callbacks:

```js
const double = (x) => x * 2;            // implicit return, no braces
const double = (x) => { return x * 2; }; // same thing, explicit
```

Python's closest thing is `lambda x: x * 2`, but arrow functions have no line
limit — they are used for real logic, not just one-liners. Real example from
[`pipeline.js`](n8n/src/lib/pipeline.js):

```js
const eligible = (applicants || []).filter((a) => {
  if (!a.applicant_id) return false;
  if (a.status === STATUS.BLOCKED) return false;
  return a.stage === STAGE.NEW;
});
```

## Lists and dicts

| Python | JavaScript | Note |
|---|---|---|
| `list` | `Array` | `[1, 2, 3]` |
| `dict` | `Object` | `{ a: 1 }` — keys need no quotes |
| `len(x)` | `x.length` | it is a property, no parentheses |
| `x.append(v)` | `x.push(v)` | |
| `d['key']` | `d.key` or `d['key']` | dot form is normal |
| `d.get('k', 0)` | `d.k ?? 0` | `??` is "if null or undefined" |
| `'k' in d` | `'k' in d` | same |
| `d.keys()` | `Object.keys(d)` | |
| `d.items()` | `Object.entries(d)` | |
| tuple | *(none)* | use an array or object |
| set | `Set` | `new Set([1, 2])`, `.has(x)`, `.add(x)` |

`Set` appears in [`intake.js`](n8n/src/lib/intake.js) for duplicate detection —
`seen.has(key)` is exactly Python's `key in seen`.

## Loops — the one that will bite you

```python
for row in rows:
    print(row)
```
```js
for (const row of rows) {   // of — iterates VALUES
  console.log(row);
}
```

**`for...in` is not the same and is almost never what you want.** It iterates
*keys*, so `for (const x in ['a','b'])` gives you `'0'` and `'1'`, not `'a'` and
`'b'`. If you find yourself typing `in`, stop and check.

## Comprehensions → map / filter

This is the biggest style shift. Python comprehensions become chained methods.

```python
emails = [r['email'] for r in rows]
valid  = [r for r in rows if r['email']]
count  = len([r for r in rows if r['stage'] == 'SENT'])
```
```js
const emails = rows.map((r) => r.email);
const valid  = rows.filter((r) => r.email);
const count  = rows.filter((r) => r.stage === 'SENT').length;
```

They chain, which is why they are everywhere in this codebase:

```js
const roles = roleRows
  .filter((r) => r.title)
  .map((r) => r.title);
```

Other useful ones:

| Python | JavaScript |
|---|---|
| `sorted(x, key=f)` | `x.sort((a, b) => ...)` — **mutates**, use `[...x].sort()` |
| `any(...)` | `x.some((v) => ...)` |
| `all(...)` | `x.every((v) => ...)` |
| `next((v for v in x if f(v)), None)` | `x.find((v) => f(v))` |
| `sum(...)` | `x.reduce((acc, v) => acc + v, 0)` |

## Strings

```python
f"Hi {name}, applying for {role}"
```
```js
`Hi ${name}, applying for ${role}`     // backticks, not quotes
```

Backtick strings can span multiple lines, which is why prompts are built with
them. Note `${}` not `{}`.

## Conditionals and the equality trap

```js
if (a === b) { ... }        // ALWAYS use === and !==
if (a == b) { ... }         // never use these
```

`==` does type coercion and produces nonsense like `'' == 0` being true.
`===` is Python's `==`. This codebase uses `===` exclusively.

```python
x = a if cond else b
```
```js
const x = cond ? a : b;
```

## Truthiness — different from Python in one important way

Falsy in JavaScript: `false`, `0`, `''`, `null`, `undefined`, `NaN`.

**An empty array `[]` and an empty object `{}` are TRUTHY in JavaScript.** In
Python they are falsy. This is the single most common bug for Python people:

```python
if not rows:            # true when rows == []
```
```js
if (rows.length === 0)  // you must check .length explicitly
```

## null vs undefined

Python has one `None`. JavaScript has two:

- `undefined` — never assigned; a missing object key; a function with no return
- `null` — deliberately set to "nothing"

You mostly do not care, which is why the codebase writes `value == null` (the one
sanctioned use of `==`) — it catches both at once. And `??`:

```js
const cap = Number(config.send_daily_cap) ?? 400;   // if null/undefined, use 400
const cap = Number(config.send_daily_cap) || 400;   // if falsy — also catches 0!
```

Know the difference: `||` would replace a legitimate `0` with `400`.

## Classes

```python
class AppError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.details = details or {}
```
```js
class AppError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
```

Very close. Differences: `this` instead of `self`, and it is *implicit* — not a
parameter. `constructor` instead of `__init__`. Default arguments work the same,
and unlike Python, a mutable default like `= {}` is safe here.

Real one: [`n8n/src/lib/errors.js`](n8n/src/lib/errors.js).

## Modules

```python
from .errors import AppError
# ... at the bottom of the file, nothing
```
```js
const { AppError } = require('./errors');
// ... at the BOTTOM of the file:
module.exports = { AppError, toAppError };
```

JavaScript has two module systems and this repo uses both:

- **CommonJS** (`require` / `module.exports`) — the `n8n/src/` engine and `tests/`
- **ES Modules** (`import` / `export`) — `scripts/*.mjs` and the whole dashboard

You can tell by the file extension: `.mjs` and `.ts`/`.tsx` are ES Modules, plain
`.js` here is CommonJS. Do not mix them in one file.

## Destructuring — very common, no Python equivalent

Pulling values out by name:

```js
const { AppError, safeJson } = require('./errors');   // from an object
const [first, second] = someArray;                     // from an array
```

Used for function arguments constantly, which is how this codebase does keyword
arguments:

```js
function planSends({ applicants, ids, config, sentToday = 0 }) { ... }

// called like:
planSends({ applicants: rows, config, sentToday: 5 });
```

That is JavaScript's version of Python's `def plan_sends(*, applicants, ids, config, sent_today=0)`.
Note `config` on its own is shorthand for `config: config`.

## Spread — `...`

```js
const updated = { ...applicant, stage: 'DRAFTED' };   // copy, then override
const all = [...listA, ...listB];                      // concatenate
```

Python's closest are `{**d, 'k': v}` and `[*a, *b]`. Used everywhere here to
build a modified copy without mutating the original.

---

# Part 2 — The five things Python basics didn't cover

## 1. Callbacks: functions as values

You have probably not passed a function to another function much. JavaScript
does it constantly:

```js
rows.filter((r) => r.email)     // the arrow function IS an argument
```

The `filter` method calls your function once per row. Nothing magic — but if
`.map((r) => ...)` looks strange, sit with it until it does not, because half
this codebase is built on it.

**Where to look:** [`pipeline.js`](n8n/src/lib/pipeline.js), every function.

## 2. async / await — the big one

This is the concept that takes real time. Budget a few days.

Anything that talks to the network (calling Groq, reading Sheets) does not
finish instantly. Python beginners usually write blocking code and never meet
this. JavaScript makes it explicit.

```js
const res = await router.complete({ task: 'draft_email', user: prompt });
console.log(res.text);   // does not run until complete() finishes
```

Rules that cover 95% of what you need:

1. A function containing `await` must be declared `async`.
2. Calling an `async` function gives you a **Promise**, not the value. You get
   the value with `await`.
3. Forgetting `await` is the classic bug — you get a `Promise { <pending> }`
   instead of your data, and nothing errors.

```js
const res = router.complete({...});      // WRONG — res is a Promise
const res = await router.complete({...}); // right
```

`async` functions bubble up: if `complete()` is async, the function calling it
must be async too, all the way to the top.

**Where to look:** [`ai-router.js`](n8n/src/lib/ai-router.js) `complete()`, and
[`wf02-draft.js`](n8n/src/nodes/wf02-draft.js) which awaits it inside a loop.

Read [`tests/ai-router.test.js`](tests/ai-router.test.js) alongside it — every
test is `async` and every call is `await`ed, so you see the pattern 20 times.

## 3. try / catch — same idea, different words

```python
try:
    ...
except ValueError as e:
    ...
finally:
    ...
```
```js
try {
  ...
} catch (err) {          // catches EVERYTHING — no exception types
  if (err.code === 'E-LLM-TIMEOUT') { ... }
} finally {
  ...
}
```

JavaScript cannot catch by type, so this codebase puts a `code` on every error
and branches on that. That is exactly why [`errors.js`](n8n/src/lib/errors.js)
exists.

## 4. `this` — read-only knowledge for now

Inside a class method, `this` is the instance (Python's `self`). You will use it
when reading `AiRouter`, but you rarely need to write tricky `this` code here.

One place it matters: in n8n Code nodes, `this` is n8n's own context object,
which is why you see `makeHttp(this, ...)`. Do not worry about the mechanism
yet; just know that is what it is.

## 5. Regular expressions

Python has them, but you may not have used them. This codebase uses them for
validation and parsing:

```js
const EMAIL_RE = /^[^\s@,;:<>()[\]\\]+@[^\s@.]+(\.[^\s@.]+)+$/;
EMAIL_RE.test('a@b.com')   // -> true
```

Slashes instead of quotes; `.test()` instead of `re.match`. Use
[regex101.com](https://regex101.com) with the "ECMAScript" flavour selected to
decode any of them.

---

# Part 3 — Guided tour, easiest first

Read these in this order. **Read the test file next to each one** — the tests are
plain English about what the code must do, and are usually easier reading than
the code.

| # | File | Lines | What you will learn | Read with |
|---|---|---|---|---|
| 1 | [`n8n/src/lib/util.js`](n8n/src/lib/util.js) | 135 | Small pure functions, `const`, string methods | `tests/util-schema.test.js` |
| 2 | [`n8n/src/lib/schema.js`](n8n/src/lib/schema.js) | 148 | Objects as data, `Object.keys`, the sheet contract | same |
| 3 | [`n8n/src/lib/errors.js`](n8n/src/lib/errors.js) | 149 | Classes, inheritance, a lookup table | same |
| 4 | [`n8n/src/lib/intake.js`](n8n/src/lib/intake.js) | 170 | Regex, validation, early return | `tests/intake.test.js` |
| 5 | [`n8n/src/lib/template.js`](n8n/src/lib/template.js) | 206 | String replace with callbacks, `.sort()` | `tests/template.test.js` |
| 6 | [`n8n/src/lib/pipeline.js`](n8n/src/lib/pipeline.js) | 336 | `.map`/`.filter` at scale, the actual business rules | `tests/pipeline.test.js` |
| 7 | [`n8n/src/lib/ai-router.js`](n8n/src/lib/ai-router.js) | 397 | **async/await**, classes, retry logic | `tests/ai-router.test.js` |
| 8 | [`n8n/src/nodes/wf02-draft.js`](n8n/src/nodes/wf02-draft.js) | 139 | How a node glues the library to n8n | `tests/bundle.test.js` |
| 9 | [`scripts/build-workflows.mjs`](scripts/build-workflows.mjs) | 156 | ES Modules, file I/O, graph validation | — |
| 10 | `dashboard/lib/*.ts` | — | TypeScript (see Part 5) | — |

**Do not start at #7.** It is the densest file in the repo and will put you off.

### While reading

Keep a `scratch.js` file at the repo root and paste bits in. Add `scratch.js`
to `.gitignore` first so you never commit it — a small but real first change:

```js
const { selectTemplate } = require('./n8n/src/lib/template.js');
console.log(selectTemplate([...], { job_role: 'Frontend Engineer' }));
```

```bash
node scratch.js
```

Faster than reasoning about code in your head.

---

# Part 4 — The exercise ladder

Twelve real changes to this codebase, in increasing difficulty. Each one
finishes with a green test run. **Do them in order.**

The rule for all of them: **write the test first, watch it fail, then make it
pass.** That is how you know the test actually tests something.

### Level 1 — reading and small edits

**1. Add an error code.** Add `E-INTAKE-PHONE` to the catalogue in
[`errors.js`](n8n/src/lib/errors.js) with a sensible hint. Add a test asserting
`new AppError('E-INTAKE-PHONE', 'x').retryable === false`.
*Learns: objects as lookup tables, the test file layout.*

**2. Add a Config default.** Add `interview_location` to `CONFIG_DEFAULTS` in
[`schema.js`](n8n/src/lib/schema.js). Run `npm test` — one test should still
pass because it only checks that every default parses. Then run
`npm run bootstrap:sheets` and watch it appear in the sheet without touching
existing values.
*Learns: how config flows, idempotent scripts.*

**3. Add a merge field.** Make `{{company_website}}` usable in templates. Touch
`buildMergeContext` in [`template.js`](n8n/src/lib/template.js) and the Config
defaults. Add a test that a template using it renders.
*Learns: following a value through several files.*

### Level 2 — logic changes

**4. Extend phone normalisation.** Make `normalisePhone` keep extensions:
`'98765 43210 x12'` → `'9876543210x12'`. Write the test first.
*Learns: regex, string methods, TDD rhythm.*

**5. Add a reply intent.** Add `'reschedule'` to `REPLY_INTENTS` in
[`pipeline.js`](n8n/src/lib/pipeline.js), update the prompt text in
`buildReplyPrompt`, and update `prompts/classify-reply.v1.md` to match. Add a
test that `checkReplySchema` accepts it.
*Learns: prompt and code must change together; why prompts are versioned.*

**6. Add a validation rule.** Reject applicants whose `name` is under 2
characters, as `E-INTAKE-MISSING`. Where in `validateIntake` does it go, and
why does order matter?
*Learns: early return, error ordering, the blocked-row concept.*

### Level 3 — the interesting parts

**7. Change template selection.** Right now `is_default` adds 1 to the score.
Make an exact role+category match beat a default even when the default also
matches the role. Read `selectTemplate`, change the scoring, prove it with a
test.
*Learns: `.sort()` with a comparator, scoring logic.*

**8. Add a send guard.** Refuse to send to any address ending `@example.com`
(a real safety win — test data leaks out this way). New error code, guard in
`planSends`, test proving nothing gets sent.
*Learns: the send safety model, why every guard has a test.*

**9. Change the model routing.** In [`ai-router.js`](n8n/src/lib/ai-router.js),
make `classify_reply` try Gemini *first* and Groq second. Three tests in
`tests/ai-router.test.js` use that route (lines 99, 109 and 117) — work out why
they now fail, then update them, because the behaviour change is intentional.
*Learns: reading async test scaffolding; that failing tests are information, not
obstacles; that changing behaviour means changing its tests deliberately.*

### Level 4 — async and the n8n seam

**10. Add a retry.** `maxAttemptsPerModel` is 3. Make it configurable from the
Config tab, threading the value from `wf02-draft.js` into the `AiRouter`
constructor.
*Learns: async plumbing, how config reaches the engine.*

**11. Add a field to the draft flow.** Make WF-02 record which model drafted
each email in a new `drafting_model` column. You will touch: `schema.js`
(column), `pipeline.js` (`assembleDraft`), `wf02-draft.js` (pass it through),
`dashboard/lib/contract.ts` (parity), and run `npm run bootstrap:sheets`.
*Learns: the full vertical slice — this is the most valuable exercise here.*

**12. Add a whole node.** Add a `emit-quota` equivalent for a new tab of your
choosing: a node body in `n8n/src/nodes/`, wired into
[`scripts/workflows.mjs`](scripts/workflows.mjs), then
`npm run build:workflows`. Watch the graph validator catch it if you wire it
wrong.
*Learns: the build system, why the JSON is generated.*

After #12 you can build V2.

---

# Part 5 — TypeScript, only what the dashboard needs

The dashboard is TypeScript — JavaScript plus type annotations. If you know
Python type hints, you already know 80% of it.

```python
def read_tab(tab: str) -> list[dict]:
```
```ts
function readTab(tab: string): Row[] { }
```

The differences that matter:

```ts
type Row = Record<string, string> & { _row: number };  // like a TypedDict
let x: string | null;                                   // Optional[str]
const rows: Row[] = [];                                 // list[Row]
```

- `interface` / `type` — named shapes, like a dataclass without behaviour
- `?` means optional: `hint?: string` is `hint: str | None = None`
- `as` is a cast — you are telling the compiler you know better. Used sparingly.

Unlike Python, these are **checked**, and the build fails if they are wrong:

```bash
cd dashboard && npm run typecheck
```

Treat that failure output as a helpful reviewer, not an obstacle. It is the
thing that will catch your mistakes fastest while you are learning.

Read in this order: `dashboard/lib/contract.ts` (just data), then
`dashboard/lib/format.ts` (small functions), then `dashboard/lib/n8n.ts`.
Leave the React components until last — React is a separate topic and you do not
need it to work on V2's backend.

---

# Part 6 — Building V2

The V2 milestones in [PLAN.md](PLAN.md) §6 assume fluency. Here they are re-cut
into learning-sized pieces, each naming what you need to know first.

Ship each one before starting the next. Every one ends with tests passing.

### V2-A — the markdown schema (no code)

Write `prompts/resume-to-markdown.v1.md` in the style of the existing prompt
docs, then hand-convert three real resumes to that shape by hand.

*Needs: nothing but the existing prompts as models.*
*Why first: you cannot write a parser until you know exactly what it produces.
This is also the cheapest place to discover the schema is wrong.*

### V2-B — resume fetching

Add `E-FETCH-*` handling: download from a Drive link or plain URL, check the
size and type, return bytes or a typed error.

*Needs: async/await, try/catch. No AI.*
*Test with: a real Drive link, a dead link, an oversized file, a `.zip`.*

### V2-C — deterministic text extraction

PDF → plain text with no model involved. This is what makes V2 affordable —
sending raw PDFs to a model roughly triples the token cost.

*Needs: an npm package (`pdf-parse` or similar) — your first dependency.*
*Stop here and check: does the extracted text look sane for a scanned PDF? It
will not. That is what V2-D is for.*

### V2-D — text → structured markdown

Add a `resume_markdown` task to `ROUTES`, a prompt, and a schema check that the
required headings are all present.

*Needs: everything in `ai-router.js`. Exercise #9 is the prerequisite.*
*Model the code on `wf02-draft.js` — it is the same shape.*

### V2-E — scoring

Score markdown against a job description. Weighted criteria, and **every
criterion score must cite a quote from the resume** — a score with no evidence
is treated as a hallucination and clamped to zero.

*Needs: V2-D, plus careful schema validation. The hardest prompt in the project.*
*Test with: two resumes you know well. If the numbers feel wrong to you, they
are wrong.*

### V2-F — the queue runner

The piece that makes 100 resumes work across quota windows: claim N rows, lease
them, process, release, reclaim stale leases.

*Needs: solid async, plus the `QuotaLedger` in `ai-router.js`.*
*This is the hardest file in V2. Do not start it before exercise #12.*

### V2-G — ranking UI

Sorted table, score breakdown drawer, throughput panel.

*Needs: React and the dashboard components. A separate learning topic — budget
a week for React basics first.*

### The order matters

A → B → C → D → E are a straight line. F can be built any time after D. G is
independent and can wait.

**Before starting E**, revisit PLAN.md §11 decision #4 (expected volume) and #5
(scoring weights). Both are still open and both change what you build.

---

# Reference

## Cheat sheet

| Python | JavaScript |
|---|---|
| `len(x)` | `x.length` |
| `x.append(v)` | `x.push(v)` |
| `str(x)` | `String(x)` |
| `int(x)` / `float(x)` | `Number(x)` |
| `f"{a} {b}"` | `` `${a} ${b}` `` |
| `x.strip()` | `x.trim()` |
| `x.split(',')` | `x.split(',')` |
| `','.join(x)` | `x.join(',')` |
| `x.lower()` | `x.toLowerCase()` |
| `x.startswith(y)` | `x.startsWith(y)` |
| `'a' in s` | `s.includes('a')` |
| `[f(v) for v in x]` | `x.map((v) => f(v))` |
| `[v for v in x if c]` | `x.filter((v) => c)` |
| `dict.get(k, d)` | `obj[k] ?? d` |
| `{**a, 'k': 1}` | `{ ...a, k: 1 }` |
| `None` | `null` / `undefined` |
| `True` / `False` | `true` / `false` |
| `and` / `or` / `not` | `&&` / `\|\|` / `!` |
| `==` | `===` |
| `# comment` | `// comment` |
| `print(x)` | `console.log(x)` |
| `raise ValueError('x')` | `throw new Error('x')` |

## Errors you will hit, and what they mean

| Message | Cause |
|---|---|
| `Cannot read properties of undefined (reading 'x')` | You did `a.b.c` and `a.b` did not exist. Use `a.b?.c`. |
| `x is not a function` | Typo in the name, or you forgot to export it from the module. |
| `x is not defined` | Missing `require` at the top of the file. |
| `Unexpected token }` | Unbalanced braces — check your indentation. |
| `Promise { <pending> }` in output | **You forgot `await`.** |
| `Assignment to constant variable` | You reassigned a `const`. Use `let`. |
| `Converting circular structure to JSON` | Use `safeJson` from `errors.js` instead. |

## Rules for this codebase

1. **Never edit a Code node inside n8n.** Edit `n8n/src/`, run
   `npm run build:workflows`, re-import. The generated JSON has a header saying so.
2. **Change `n8n/src/lib/schema.js` and `dashboard/lib/contract.ts` together.**
   `tests/contract-parity.test.js` will fail if you do not.
3. **`npm run verify` before you commit.** Tests plus graph validation.
4. **Every new failure mode gets a code in `errors.js`.** The whole error system
   depends on nothing throwing an untyped error.
5. **Anything that can email a candidate gets a test proving when it refuses.**

## Where to look things up

- **[MDN](https://developer.mozilla.org)** — the reference. Search `mdn array filter`,
  not `w3schools`.
- **[javascript.info](https://javascript.info)** — the best free tutorial. Read
  the "Promises, async/await" chapter when you get to Part 2.
- **This repo's tests** — for "how do I use this function", the test file is
  usually the clearest answer available.
