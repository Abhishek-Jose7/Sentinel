# Sentinel v2 — Hybrid Scoring & Pattern Memory

This is a design addendum on top of the original build guide. It addresses three weaknesses in v1: an unaccountable LLM-only score, overclaiming "auditor" when the install scan is really a posture check, and an underbuilt memory feature that's sitting on the most interesting part of the product.

---

## 1. Positioning Change

**Old framing:** Production Readiness Auditor
**New framing:** Sentinel **audits what can be verified, and predicts what can't.**

- *Audited:* deterministic, binary checks — rate limiting present/absent, health endpoint present/absent, env validation present/absent, structured logging present/absent. These are facts, not LLM opinions.
- *Predicted:* diff-level reasoning and historical pattern matching — "this looks like the bug that broke checkout six weeks ago." This is genuinely inference, and should be labeled as such.

This framing pre-empts the "is this just an LLM guessing a number" question instead of dodging it, and gives you a stronger line than picking one word.

---

## 2. Hybrid Scoring

### Problem with v1

The score comes entirely from LLM-generated dimension ratings (`security: 68`, `reliability: 62`, etc.) with no underlying rule a judge can check. "Why 74 instead of 67?" has no good answer.

### Fix: deterministic checks clamp the LLM score

Add `src/rules.ts` — plain pattern checks run against the same file set already collected (`PRIORITY_PATTERNS` files + PR diff). No new data fetching required.

```typescript
// src/rules.ts

export interface RuleHit {
  id: string;
  dimension: 'security' | 'reliability' | 'observability' | 'performance' | 'deployment';
  penalty: number;
  title: string;
  description: string;
}

interface RuleInput {
  files: Record<string, string>;   // priority-pattern files
  diff?: string;                   // PR diff, if present
  changedFiles?: string[];
}

const RATE_LIMIT_PATTERNS = [/express-rate-limit/i, /rate-?limit/i, /@hono\/rate-limiter/i];
const HEALTH_ROUTE_PATTERNS = [/['"`]\/health/i, /['"`]\/healthz/i, /['"`]\/ping['"`]/i];
const ENV_VALIDATION_PATTERNS = [/\bzod\b/i, /envsafe/i, /\bjoi\b/i, /process\.env\.\w+\s*\?\?/];
const LOGGING_PATTERNS = [/winston/i, /pino/i, /console\.error/];
const TRY_CATCH_AROUND_ASYNC = /try\s*{[^}]*await[^}]*}\s*catch/s;

export function runDeterministicChecks(input: RuleInput): RuleHit[] {
  const hits: RuleHit[] = [];
  const allText = Object.values(input.files).join('\n') + '\n' + (input.diff ?? '');

  if (!RATE_LIMIT_PATTERNS.some(p => p.test(allText))) {
    hits.push({
      id: 'no-rate-limit',
      dimension: 'reliability',
      penalty: 15,
      title: 'No rate limiting detected',
      description: 'No rate-limiting middleware found in repo or diff.',
    });
  }

  if (!HEALTH_ROUTE_PATTERNS.some(p => p.test(allText))) {
    hits.push({
      id: 'no-health-endpoint',
      dimension: 'observability',
      penalty: 10,
      title: 'No health check endpoint',
      description: 'No /health, /healthz, or /ping route found.',
    });
  }

  if (/process\.env\./.test(allText) && !ENV_VALIDATION_PATTERNS.some(p => p.test(allText))) {
    hits.push({
      id: 'no-env-validation',
      dimension: 'deployment',
      penalty: 10,
      title: 'No environment variable validation',
      description: 'process.env is read directly with no schema validation library detected.',
    });
  }

  if (!LOGGING_PATTERNS.some(p => p.test(allText))) {
    hits.push({
      id: 'no-structured-logging',
      dimension: 'observability',
      penalty: 10,
      title: 'No structured logging',
      description: 'No logging library and no console.error usage found.',
    });
  }

  if (input.diff && /await\s+\w+\.\w+\(/.test(input.diff) && !TRY_CATCH_AROUND_ASYNC.test(input.diff)) {
    hits.push({
      id: 'unhandled-async',
      dimension: 'reliability',
      penalty: 10,
      title: 'Unwrapped async call in diff',
      description: 'An awaited call was added without a surrounding try/catch.',
    });
  }

  return hits;
}

export function applyPenalties(
  llmDimensions: Record<string, number>,
  hits: RuleHit[]
): { dimensions: Record<string, number>; penaltiesByDimension: Record<string, RuleHit[]> } {
  const penaltiesByDimension: Record<string, RuleHit[]> = {};
  for (const hit of hits) {
    (penaltiesByDimension[hit.dimension] ??= []).push(hit);
  }

  const dimensions: Record<string, number> = { ...llmDimensions };
  for (const [dim, dimHits] of Object.entries(penaltiesByDimension)) {
    const totalPenalty = dimHits.reduce((sum, h) => sum + h.penalty, 0);
    const ceiling = Math.max(0, 100 - totalPenalty);
    dimensions[dim] = Math.min(dimensions[dim] ?? 100, ceiling);
  }

  return { dimensions, penaltiesByDimension };
}
```

### Wiring it in (`webhook.ts`)

```typescript
import { runDeterministicChecks, applyPenalties } from './rules';

// after runAnalysis(...) returns `result`:
const hits = runDeterministicChecks({ files, diff, changedFiles });
const { dimensions, penaltiesByDimension } = applyPenalties(result.dimensions, hits);
result.dimensions = dimensions;
result.overallScore = computeScore(dimensions); // existing weighted formula, now fed clamped values
```

### Surfacing it in the PR comment

Add a line per dimension that was capped:

```
Dimension         Score   Notes
Reliability       62/100  capped by: no rate limiting (-15), unwrapped async call (-10)
Observability     70/100  capped by: no health endpoint (-10)
```

This is the literal answer to "why 74 and not 67" — print the rule IDs and penalties, not just the final number.

---

## 3. Structured Pattern Memory

### Problem with v1

Parcle stores freeform prose summaries (`"[Sentinel PR #47] repo scored 74/100..."`) and recall is a single semantic query. The LLM might *notice* a past incident matches the current PR, but nothing forces it to, and there's no structured way to surface "this exact pattern happened before."

### Fix: tag every stored memory with a pattern ID, and recall by pattern first

Pattern IDs come straight from the deterministic rule IDs above (`no-rate-limit`, `unhandled-async`, etc.) plus a few LLM-assigned ones for things rules can't catch (`missing-retry-on-external-call`, `race-condition-on-shared-state`).

**`src/parcle.ts` — extend the interface:**

```typescript
export interface PatternMemory extends Memory {
  metadata?: {
    tags: string[];
    pattern?: string;       // structured pattern ID, e.g. 'no-rate-limit'
    repo?: string;
    prNumber?: number;
    resolved?: boolean;
    source: 'Sentinel';
    ts: number;
  };
}

export class ParcleClient {
  // ...existing store/recall...

  async storePattern(
    content: string,
    pattern: string,
    repo: string,
    extra: { tags?: string[]; prNumber?: number; resolved?: boolean } = {}
  ): Promise<void> {
    await this.store(content, [pattern, repo, ...(extra.tags ?? [])]);
    // pattern is also embedded in metadata via the tags array above;
    // if Parcle supports arbitrary metadata fields, pass { pattern, repo, ...extra } directly
  }

  async recallByPattern(pattern: string, repo: string, limit = 4): Promise<Memory[]> {
    return this.recall(`pattern:${pattern} repo:${repo}`, limit);
  }
}
```

**In `webhook.ts` — recall by pattern, not just semantics:**

```typescript
// After running deterministic checks and getting `hits`:
const patternMatches = await Promise.all(
  hits.map(h => parcle.recallByPattern(h.id, repository.full_name))
);

const matchedHistory = hits
  .map((h, i) => ({ hit: h, memories: patternMatches[i] }))
  .filter(m => m.memories.length > 0);
```

**Store with pattern tags after analysis:**

```typescript
for (const risk of result.risks) {
  const pattern = risk.id; // kebab-case from the LLM schema, or a matched rule id
  await parcle.storePattern(
    `[PR #${pr_number}] ${risk.title} in ${risk.location}. ${risk.why}`,
    pattern,
    repository.full_name,
    { prNumber: pr_number, tags: [risk.severity] }
  );
}
```

### Surfacing it as its own PR comment section

This is the highest-value real estate in the comment — give it a distinct block above the generic risk list:

```
🧠 Pattern Match

This PR introduces a missing-retry pattern in `notifications/send.ts`.
The same pattern caused a checkout failure incident 6 weeks ago
(`src/checkout/process.ts`, PR #31).
```

Generated via a new `formatter.ts` function:

```typescript
export function buildPatternMatchSection(
  matchedHistory: Array<{ hit: RuleHit; memories: Memory[] }>
): string {
  if (!matchedHistory.length) return '';
  const blocks = matchedHistory.map(({ hit, memories }) =>
    `**${hit.title}** in this PR matches a stored pattern (\`${hit.id}\`):\n` +
    memories.map(m => `> ${m.content}`).join('\n')
  );
  return `### 🧠 Pattern Match\n\n${blocks.join('\n\n')}`;
}
```

Insert this section right after the summary line in `buildPRComment`, before the dimension table — it's the line a judge will remember, so it shouldn't be buried under generic risk cards.

---

## 4. Updated Demo Script (insert after step 4)

1. Show the GitHub App install page — one click, no config.
2. Show the initial analysis firing on `installation.created`.
3. Open a PR with a deliberate flaw that matches a *previously seen* pattern (e.g. push a second missing-retry bug after seeding one earlier in the demo repo's history).
4. Show the PR comment appear — lead with the **Pattern Match** section, not the score.
5. Point at the dimension table and read the penalty notes aloud: *"reliability lost 25 points from two deterministic checks, the LLM only had room to score the rest."*
6. Show the check run, then the auto-opened issue for the critical.
7. Open the dashboard — score ring, dimension bars with penalty annotations, pattern-match panel.
8. Close on the positioning line: *"Sentinel audits what it can verify, and predicts what it can't — and the predictions get sharper every time it runs."*

---

## 5. Summary of Changes

| Area | v1 | v2 |
|---|---|---|
| Score source | LLM dimension ratings only | Deterministic rule penalties clamp LLM ratings |
| Explainability | None — score is opaque | Every capped dimension lists the rule IDs and point deductions |
| Positioning | "Production Readiness Auditor" | "Audits what's verifiable, predicts what isn't" |
| Memory | Freeform prose, single semantic recall | Structured pattern IDs, recalled by pattern + repo |
| PR comment | Risk list only | Dedicated "Pattern Match" section surfaced above the risk list |
| Demo narrative | "Memory panel populated" | Named, dated, specific recall: "this caused an incident 6 weeks ago" |
