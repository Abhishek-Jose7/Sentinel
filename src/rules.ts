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

export interface RepositoryFacts {
  scannedFileCount: number;
  scannedPaths: string[];
  architecture: string[];
  hasRateLimiting: boolean;
  hasHealthEndpoint: boolean;
  hasStructuredLogging: boolean;
  hasEnvValidation: boolean;
  hasTests: boolean;
  hasMonitoring: boolean;
  hasCiConfig: boolean;
  hasDockerfile: boolean;
  hasPackageLock: boolean;
  usesDatabase: boolean;
  usesAuthentication: boolean;
  envReads: string[];
}

const RATE_LIMIT_PATTERNS = [/express-rate-limit/i, /rate-?limit/i, /@hono\/rate-limiter/i];
const HEALTH_ROUTE_PATTERNS = [/['"`]\/health/i, /['"`]\/healthz/i, /['"`]\/ping['"`]/i];
const ENV_VALIDATION_PATTERNS = [/\bzod\b/i, /envsafe/i, /\bjoi\b/i, /envalid/i, /process\.env\.\w+\s*\?\?/];
const LOGGING_PATTERNS = [/\bwinston\b/i, /\bpino\b/i, /\bbunyan\b/i, /console\.error/];
const MONITORING_PATTERNS = [/prom-client/i, /sentry/i, /opentelemetry/i, /datadog/i, /newrelic/i];
const TRY_CATCH_AROUND_ASYNC = /try\s*{[^}]*await[^}]*}\s*catch/s;

function hasAny(patterns: RegExp[], text: string): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function pathMatches(paths: string[], pattern: RegExp): boolean {
  return paths.some(path => pattern.test(path));
}

export function extractRepositoryFacts(files: Record<string, string>): RepositoryFacts {
  const entries = Object.entries(files);
  const paths = entries.map(([path]) => path);
  const allText = entries.map(([path, content]) => `--- ${path} ---\n${content}`).join('\n');
  const packageJsonText = files['package.json'] || Object.entries(files).find(([path]) => path.endsWith('/package.json'))?.[1] || '';

  const architecture = new Set<string>();
  const architectureChecks: Array<[string, RegExp]> = [
    ['Next.js frontend', /"next"\s*:|from ['"]next|next\/config/i],
    ['React frontend', /"react"\s*:|from ['"]react/i],
    ['Express backend', /"express"\s*:|from ['"]express|require\(['"]express/i],
    ['Hono worker', /"hono"\s*:|from ['"]hono/i],
    ['Cloudflare Worker', /wrangler\.json|wrangler\.toml|export default\s*{[\s\S]*fetch/i],
    ['PostgreSQL', /postgres|pg-promise|\bpg\b|DATABASE_URL/i],
    ['SQLite/D1', /D1Database|wrangler d1|sqlite/i],
    ['Prisma ORM', /"prisma"\s*:|@prisma\/client|schema\.prisma/i],
    ['TypeScript', /tsconfig\.json|\.tsx?$|typescript/i],
    ['Node.js', /package\.json|node_modules|npm run/i]
  ];
  for (const [label, pattern] of architectureChecks) {
    if (pattern.test(allText) || pattern.test(paths.join('\n')) || pattern.test(packageJsonText)) {
      architecture.add(label);
    }
  }

  const envReads = Array.from(allText.matchAll(/process\.env\.([A-Z0-9_]+)/gi))
    .map(match => match[1])
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, 20);

  return {
    scannedFileCount: entries.length,
    scannedPaths: paths.slice(0, 80),
    architecture: Array.from(architecture),
    hasRateLimiting: hasAny(RATE_LIMIT_PATTERNS, allText),
    hasHealthEndpoint: hasAny(HEALTH_ROUTE_PATTERNS, allText),
    hasStructuredLogging: hasAny(LOGGING_PATTERNS, allText),
    hasEnvValidation: hasAny(ENV_VALIDATION_PATTERNS, allText),
    hasTests: pathMatches(paths, /(^|\/)(__tests__|tests?|spec)\//i) || pathMatches(paths, /\.(test|spec)\.[jt]sx?$/i) || /"test"\s*:/.test(packageJsonText),
    hasMonitoring: hasAny(MONITORING_PATTERNS, allText),
    hasCiConfig: pathMatches(paths, /^\.github\/workflows\//i) || pathMatches(paths, /(^|\/)(circleci|buildkite|gitlab-ci|jenkinsfile)/i),
    hasDockerfile: pathMatches(paths, /(^|\/)Dockerfile$/i) || pathMatches(paths, /docker-compose/i),
    hasPackageLock: pathMatches(paths, /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i),
    usesDatabase: /DATABASE_URL|postgres|mysql|sqlite|prisma|drizzle|D1Database/i.test(allText),
    usesAuthentication: /jwt|oauth|passport|next-auth|auth0|clerk|supabase.auth/i.test(allText),
    envReads
  };
}

export function runDeterministicChecks(input: RuleInput): RuleHit[] {
  const hits: RuleHit[] = [];
  const facts = extractRepositoryFacts(input.files);

  if (!facts.hasRateLimiting) {
    hits.push({
      id: 'no-rate-limit',
      dimension: 'reliability',
      penalty: 15,
      title: 'No rate limiting detected',
      description: 'No rate-limiting middleware found in repo or diff.',
    });
  }

  if (!facts.hasHealthEndpoint) {
    hits.push({
      id: 'no-health-endpoint',
      dimension: 'observability',
      penalty: 10,
      title: 'No health check endpoint',
      description: 'No /health, /healthz, or /ping route found.',
    });
  }

  if (facts.envReads.length > 0 && !facts.hasEnvValidation) {
    hits.push({
      id: 'no-env-validation',
      dimension: 'deployment',
      penalty: 10,
      title: 'No environment variable validation',
      description: 'process.env is read directly with no schema validation library detected.',
    });
  }

  if (!facts.hasStructuredLogging) {
    hits.push({
      id: 'no-structured-logging',
      dimension: 'observability',
      penalty: 10,
      title: 'No structured logging',
      description: 'No logging library and no console.error usage found.',
    });
  }

  if (!facts.hasTests) {
    hits.push({
      id: 'no-tests-detected',
      dimension: 'reliability',
      penalty: 12,
      title: 'No tests detected',
      description: 'No test script, test directory, or *.test/*.spec files were found in scanned repository files.',
    });
  }

  if (!facts.hasMonitoring) {
    hits.push({
      id: 'no-monitoring-detected',
      dimension: 'observability',
      penalty: 8,
      title: 'No monitoring or tracing detected',
      description: 'No monitoring, tracing, or error reporting SDK was found in scanned repository files.',
    });
  }

  if (!facts.hasCiConfig) {
    hits.push({
      id: 'no-ci-config-detected',
      dimension: 'deployment',
      penalty: 8,
      title: 'No CI workflow detected',
      description: 'No GitHub Actions, GitLab CI, CircleCI, Buildkite, or Jenkins workflow was found.',
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

export function scoreFromFacts(hits: RuleHit[]): Record<string, number> {
  const dimensions: Record<string, number> = {
    security: 88,
    reliability: 88,
    observability: 88,
    performance: 88,
    deployment: 88
  };

  for (const hit of hits) {
    dimensions[hit.dimension] = Math.max(0, dimensions[hit.dimension] - hit.penalty);
  }

  return dimensions;
}

export function calculateOverallScore(dimensions: Record<string, number>): number {
  return Math.round(
    ((dimensions.security ?? 0) * 0.30) +
    ((dimensions.reliability ?? 0) * 0.25) +
    ((dimensions.observability ?? 0) * 0.15) +
    ((dimensions.performance ?? 0) * 0.15) +
    ((dimensions.deployment ?? 0) * 0.15)
  );
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
