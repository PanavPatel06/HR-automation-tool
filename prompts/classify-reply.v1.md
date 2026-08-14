# classify-reply.v1

Used by **WF-04 Reply Watcher**. Source of truth: `buildReplyPrompt()` and
`checkReplySchema()` in `n8n/src/lib/pipeline.js`.

## System

> You classify recruiting email replies. You return JSON only. When in doubt you
> answer "unclear" with low confidence.

## User

```
Classify this reply from a job candidate.

Return JSON only: {"intent": "...", "confidence": 0.0, "summary": "..."}
intent must be one of: interested, declined, question, out_of_office, unclear.
confidence is 0.0-1.0. summary is one sentence, max 140 characters.
If the message is ambiguous, say "unclear" with low confidence rather than guessing.

--- reply ---
{first 4000 characters of the reply}
```

## The confidence floor

Below `reply_confidence_min` (Config, default 0.7) the intent is forced to
`unclear` and `reply_state` becomes `needs_human`, with `W-REPLY-LOWCONF`
recorded.

This is the important design decision in WF-04: **the model sorts the inbox, it
does not decide outcomes.** A misclassified "declined" that silently closed a
strong candidate would be an expensive, invisible failure, so the system prefers
to escalate. Nothing downstream acts on the intent automatically in V1.

## Model choice

Routed to the 8B-class model first: the input is short, the task is
near-mechanical, and 70B-class quota is better spent on drafting. Gemini Flash
is the fallback.
