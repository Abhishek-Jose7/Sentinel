// src/rules.ts

export interface RuleHit {
  id: string;
  dimension: 'security' | 'reliability' | 'observability' | 'performance' | 'deployment';
  penalty: number;
  title: string;
  description: string;
}

export interface RuleInput {
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
