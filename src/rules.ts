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
  hasEvalUsage: boolean;
  hasSyncFsUsage: boolean;
  hasHardcodedSecrets: boolean;
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
    hasCiConfig: pathMatches(paths, /(^|\/)\.github\/workflows\//i) || pathMatches(paths, /(^|\/)(circleci|buildkite|gitlab-ci|jenkinsfile)/i),
    hasDockerfile: pathMatches(paths, /(^|\/)Dockerfile$/i) || pathMatches(paths, /docker-compose/i),
    hasPackageLock: pathMatches(paths, /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i),
    usesDatabase: /DATABASE_URL|postgres|mysql|sqlite|prisma|drizzle|D1Database/i.test(allText),
    usesAuthentication: /jwt|oauth|passport|next-auth|auth0|clerk|supabase.auth/i.test(allText),
    envReads,
    hasEvalUsage: /\beval\s*\(/g.test(allText),
    hasSyncFsUsage: /\b(read|write|append)FileSync\b/g.test(allText),
    hasHardcodedSecrets: /(password|passwd|api_key|client_secret|private_key)\s*=\s*['"`][a-zA-Z0-9_\-]{8,}['"`]/i.test(allText)
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

  if (facts.hasEvalUsage || (input.diff && /\beval\s*\(/.test(input.diff))) {
    hits.push({
      id: 'eval-usage',
      dimension: 'security',
      penalty: 15,
      title: 'Eval usage detected',
      description: 'Avoid using eval() as it exposes the application to code injection vulnerabilities.',
    });
  }

  if (facts.hasHardcodedSecrets || (input.diff && /(password|passwd|api_key|client_secret|private_key)\s*=\s*['"`][a-zA-Z0-9_\-]{8,}['"`]/i.test(input.diff))) {
    hits.push({
      id: 'hardcoded-secrets',
      dimension: 'security',
      penalty: 20,
      title: 'Potential hardcoded secrets',
      description: 'Avoid committing hardcoded credentials, API keys, or private tokens in code.',
    });
  }

  if (facts.hasSyncFsUsage || (input.diff && /\b(read|write|append)FileSync\b/.test(input.diff))) {
    hits.push({
      id: 'sync-fs-usage',
      dimension: 'performance',
      penalty: 15,
      title: 'Sync filesystem usage',
      description: 'Sync filesystem methods block the single-threaded event loop and degrade worker performance.',
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
    security: 100,
    reliability: 100,
    observability: 100,
    performance: 100,
    deployment: 100
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

export function cleanVersion(ver: string): string {
  // Strip leading specifiers like ^, ~, >=, <=, etc.
  let cleaned = ver.trim().replace(/^[\^~>=<]+/g, '');
  if (!cleaned || cleaned === '*' || cleaned === 'latest') {
    return '0.0.0';
  }
  // Split by whitespace, logical OR (||), or hyphen ranges (-)
  cleaned = cleaned.split(/\s*\|\|\s*/)[0];
  cleaned = cleaned.split(/\s+or\s+/i)[0];
  cleaned = cleaned.split(/\s*-\s*/)[0];
  cleaned = cleaned.trim();
  
  // Extract first semver-like pattern (e.g. 1.2.3)
  const match = cleaned.match(/\d+\.\d+\.\d+/);
  return match ? match[0] : cleaned;
}

export async function checkPackageVulnerabilities(
  packageJsonContent: string,
  packageLockContent?: string
): Promise<RuleHit[]> {
  const hits: RuleHit[] = [];
  try {
    let pkgJson: any;
    try {
      pkgJson = JSON.parse(packageJsonContent);
    } catch (e) {
      console.error('Failed to parse package.json content:', e);
      return hits;
    }

    const dependencies = {
      ...(pkgJson.dependencies || {}),
      ...(pkgJson.devDependencies || {})
    };

    if (Object.keys(dependencies).length === 0) {
      return hits;
    }

    // Try parsing package-lock.json to find exact versions
    const exactVersions: Record<string, string> = {};
    if (packageLockContent) {
      try {
        const lockJson = JSON.parse(packageLockContent);
        // package-lock v2/v3 has packages property
        if (lockJson.packages) {
          for (const [key, value] of Object.entries(lockJson.packages)) {
            if (key.startsWith('node_modules/')) {
              const name = key.replace(/^node_modules\//, '');
              if (value && typeof value === 'object' && (value as any).version) {
                exactVersions[name] = (value as any).version;
              }
            }
          }
        }
        // package-lock v1 / fallback has dependencies property
        if (lockJson.dependencies) {
          for (const [name, value] of Object.entries(lockJson.dependencies)) {
            if (value && typeof value === 'object' && (value as any).version) {
              exactVersions[name] = (value as any).version;
            }
          }
        }
      } catch (e) {
        console.error('Failed to parse package-lock.json content:', e);
      }
    }

    // Prepare OSV.dev batch query
    const queries = [];
    const packageList: Array<{ name: string; version: string }> = [];

    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec !== 'string') continue;
      const exactVer = exactVersions[name] || cleanVersion(spec);
      queries.push({
        package: {
          name,
          ecosystem: 'npm'
        },
        version: exactVer
      });
      packageList.push({ name, version: exactVer });
    }

    if (queries.length === 0) {
      return hits;
    }

    // Make batch POST request to OSV.dev
    const response = await fetch('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ queries })
    });

    if (!response.ok) {
      console.error(`OSV.dev querybatch failed: ${response.status} ${await response.text()}`);
      return hits;
    }

    const data = await response.json() as any;
    const results = data.results || [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const pkg = packageList[i];
      if (result && result.vulns && result.vulns.length > 0) {
        const vulnIds = result.vulns.map((v: any) => v.id).join(', ');
        hits.push({
          id: `vulnerable-package-${pkg.name}`,
          dimension: 'security',
          penalty: 10,
          title: `Vulnerable dependency: ${pkg.name}`,
          description: `Package ${pkg.name}@${pkg.version} has active vulnerabilities: ${vulnIds}. Please upgrade to a secure version.`
        });
      }
    }
  } catch (err) {
    console.error('Error during package vulnerability check:', err);
  }

  return hits;
}

export interface InlineViolation {
  path: string;
  line: number;
  ruleId: string;
  title: string;
  description: string;
  suggestion?: string;
}

export function scanDiffForInlineViolations(diff: string): InlineViolation[] {
  const violations: InlineViolation[] = [];
  if (!diff) return violations;

  const lines = diff.split('\n');
  let currentFile = '';
  let currentLine = 0;

  // Regex patterns for secrets
  const SECRET_PATTERNS = [
    {
      regex: /(password|passwd|api_key|client_secret|private_key|auth_token|access_token|credential)\s*[:=]\s*['"`]([a-zA-Z0-9_\-\.\~\+\/]{12,})['"`]/i,
      message: 'Avoid committing hardcoded credentials, API keys, or private tokens in code. Use environment variables or a secrets manager.',
      suggestion: '// Use environment variables instead\n// const api_key = process.env.API_KEY;'
    },
    {
      regex: /-----BEGIN (RSA |EC |PGP )?PRIVATE KEY-----/,
      message: 'Private key detected. Do not commit cryptographic private keys to source control.',
    },
    {
      regex: /(mongodb(\+srv)?|postgres(ql)?|mysql):\/\/[^:]+:[^@]+@/,
      message: 'Database connection string containing credentials detected. Store database URLs in environment variables.',
    },
    {
      regex: /xox[bapr]-[0-9]{12}-[a-zA-Z0-9]{24}/,
      message: 'Potential Slack token detected. Revoke immediately and move to environment variables.',
    },
    {
      regex: /AKIA[0-9A-Z]{16}/,
      message: 'Potential AWS Access Key ID detected. Use AWS IAM roles or environment credentials.',
    },
    {
      regex: /sk_live_[0-9a-zA-Z]{24}/,
      message: 'Potential Stripe live API key detected. Revoke immediately and use sandbox keys or environment variables.',
    },
    {
      regex: /ghp_[0-9a-zA-Z]{36}/,
      message: 'Potential GitHub Personal Access Token detected. Revoke immediately and use GitHub Actions secret injection or App tokens.',
    }
  ];

  for (const line of lines) {
    // 1. Detect file start
    // e.g. diff --git a/src/index.ts b/src/index.ts
    const fileMatch = line.match(/^diff --git a\/(.*?) b\/(.*?)$/);
    if (fileMatch) {
      currentFile = fileMatch[2];
      currentLine = 0;
      continue;
    }

    // 2. Detect hunk header
    // e.g. @@ -10,6 +10,7 @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1]);
      continue;
    }

    // If we don't have a current file or line number tracking hasn't started yet, skip
    if (!currentFile || currentLine === 0) {
      continue;
    }

    // 3. Process diff lines
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.substring(1);

      // Check eval usage
      if (/\beval\s*\(/.test(content)) {
        violations.push({
          path: currentFile,
          line: currentLine,
          ruleId: 'eval-usage',
          title: 'Eval usage detected',
          description: 'Avoid using eval() as it exposes the application to code injection vulnerabilities.',
          suggestion: '```suggestion\n// Use JSON.parse or structured logic instead of eval\n```'
        });
      }

      // Check sync FS usage
      if (/\b(read|write|append)FileSync\b/.test(content)) {
        violations.push({
          path: currentFile,
          line: currentLine,
          ruleId: 'sync-fs-usage',
          title: 'Sync filesystem usage',
          description: 'Sync filesystem methods block the single-threaded event loop and degrade worker performance.',
          suggestion: '```suggestion\n// Use asynchronous filesystem methods\n```'
        });
      }

      // Check for secrets
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.regex.test(content)) {
          violations.push({
            path: currentFile,
            line: currentLine,
            ruleId: 'hardcoded-secrets',
            title: 'Potential hardcoded secrets',
            description: pattern.message,
            suggestion: pattern.suggestion ? `\`\`\`suggestion\n${pattern.suggestion}\n\`\`\`` : undefined
          });
          break; // Avoid duplicate secret matches on the same line
        }
      }

      currentLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Deleted line, do not increment currentLine
    } else {
      // Unchanged line (context line)
      currentLine++;
    }
  }

  return violations;
}
