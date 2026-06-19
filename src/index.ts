// src/index.ts

import { DbHelper } from './db';
import { runDeterministicChecks, applyPenalties, RuleHit } from './rules';
import { ParcleClient, PatternMemory } from './parcle';
import { GroqEngine } from './groq';
import { GitHubClient, verifyWebhookSignature, buildPRComment, buildPatternMatchSection } from './github';

export interface Env {
  DB: any; // D1Database
  GROQ_API_KEY?: string;
  PARCLE_API_KEY?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string; // PEM format
  GITHUB_WEBHOOK_SECRET?: string;
}

const PRIORITY_PATTERNS = [
  'package.json',
  'wrangler.toml',
  'wrangler.json',
  'tsconfig.json',
  'src/index.ts',
  'src/index.js',
  'src/server.ts',
  'src/app.ts',
  'src/main.ts',
  'server.js',
  'app.js',
  'index.js'
];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle OPTIONS CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      // 1. Webhook Handler
      if (path === '/webhook' && request.method === 'POST') {
        return await handleWebhook(request, env, ctx);
      }

      const db = new DbHelper(env.DB);

      // 2. API: List Repositories
      if (path === '/api/repos' && request.method === 'GET') {
        const repos = await db.listRepos();
        return new Response(JSON.stringify(repos), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      // 3. API: Repository Detail
      const repoMatch = path.match(/^\/api\/repos\/([^\/]+)\/([^\/]+)$/);
      if (repoMatch && request.method === 'GET') {
        const owner = repoMatch[1];
        const name = repoMatch[2];
        const repo = await db.getRepo(owner, name);
        if (!repo) {
          return new Response(JSON.stringify({ error: 'Repository not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }
        const prs = await db.getRepoPRs(repo.id);
        return new Response(JSON.stringify({ repository: repo, pullRequests: prs }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      // 4. API: PR scan details
      const prMatch = path.match(/^\/api\/repos\/([^\/]+)\/([^\/]+)\/pr\/(\d+)$/);
      if (prMatch && request.method === 'GET') {
        const owner = prMatch[1];
        const name = prMatch[2];
        const prNumber = parseInt(prMatch[3]);
        const repo = await db.getRepo(owner, name);
        if (!repo) {
          return new Response(JSON.stringify({ error: 'Repository not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }
        
        const prId = `${owner}/${name}/pull/${prNumber}`;
        const pr = await db.getPR(prId);
        if (!pr) {
          return new Response(JSON.stringify({ error: 'PR scan not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        const hits = await db.getPRRuleHits(prId);
        const risks = await db.getPRRisks(prId);
        
        // Recall memories for the rule hits to display in dashboard pattern-match panel
        const parcle = new ParcleClient(env.PARCLE_API_KEY || null, env.DB);
        const patternMatches = await Promise.all(
          hits.map(h => parcle.recallByPattern(h.rule_id, `${owner}/${name}`))
        );
        const matchedHistory = hits.map((h, i) => ({
          hit: h,
          memories: patternMatches[i]
        })).filter(m => m.memories.length > 0);

        return new Response(JSON.stringify({ pr, ruleHits: hits, risks, patternMatches: matchedHistory }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      // 5. API: Activate Enter Pro
      if (path === '/api/pro/activate' && request.method === 'POST') {
        const body = await request.json() as any;
        const { owner, repo, licenseKey } = body;
        if (!owner || !repo || !licenseKey) {
          return new Response(JSON.stringify({ error: 'Missing parameters' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }
        const success = await db.activatePro(owner, repo, licenseKey);
        if (success) {
          return new Response(JSON.stringify({ message: 'Sentinel Pro Activated successfully' }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        } else {
          return new Response(JSON.stringify({ error: 'Invalid Sentinel Pro license key format' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }
      }

      // 6. Serve Enter Pro Dashboard Frontend
      if (path === '/' || path === '/dashboard' || path === '/index.html') {
        const html = await fetchDashboardHtml(env);
        return new Response(html, {
          headers: { 'Content-Type': 'text/html' }
        });
      }

      if (path === '/styles.css') {
        const css = await fetchDashboardCss();
        return new Response(css, {
          headers: { 'Content-Type': 'text/css' }
        });
      }

      if (path === '/app.js') {
        const js = await fetchDashboardJs();
        return new Response(js, {
          headers: { 'Content-Type': 'application/javascript' }
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error('Request execution error:', err);
      return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
  }
};

// Webhook handling routine
async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const payloadText = await request.text();
  const signature = request.headers.get('x-hub-signature-256') || '';
  
  if (env.GITHUB_WEBHOOK_SECRET) {
    const verified = await verifyWebhookSignature(payloadText, signature, env.GITHUB_WEBHOOK_SECRET);
    if (!verified) {
      return new Response('Invalid webhook signature', { status: 401 });
    }
  }

  const payload = JSON.parse(payloadText);
  const eventName = request.headers.get('x-github-event') || '';

  // Process installation creation
  if (eventName === 'installation' && (payload.action === 'created' || payload.action === 'added')) {
    const db = new DbHelper(env.DB);
    const repos = payload.repositories || payload.repositories_added || [];
    for (const r of repos) {
      await db.upsertRepo(r.id, payload.installation.account.login, r.name);
    }
    return new Response('Installation processed successfully', { status: 200 });
  }

  // Process pull request validation
  if (eventName === 'pull_request' && (payload.action === 'opened' || payload.action === 'synchronize')) {
    // Execute full reasoning/clamping audit loop asynchronously so GitHub doesn't timeout
    ctx.waitUntil(runAuditLoop(payload, env));
    return new Response('Audit triggered', { status: 202 });
  }

  return new Response('Event skipped', { status: 200 });
}

// Full recall -> reason -> store loop
async function runAuditLoop(payload: any, env: Env) {
  const prNumber = payload.number;
  const repository = payload.repository;
  const repoOwner = repository.owner.login;
  const repoName = repository.name;
  const repoFullName = repository.full_name;
  const installationId = payload.installation.id;
  const headSha = payload.pull_request.head.sha;
  const prTitle = payload.pull_request.title;
  const prId = `${repoFullName}/pull/${prNumber}`;

  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    console.error('GITHUB_APP_ID or GITHUB_PRIVATE_KEY is not defined. Cannot run audit.');
    return;
  }

  const db = new DbHelper(env.DB);
  const github = new GitHubClient(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);
  const parcle = new ParcleClient(env.PARCLE_API_KEY || null, env.DB);
  const groq = new GroqEngine(env.GROQ_API_KEY || 'dummy_key');

  let checkRunId = 0;
  let token = '';

  try {
    // 1. Authenticate GitHub App
    token = await github.getInstallationToken(installationId);
    
    // Register repo in DB if missing
    await db.upsertRepo(repository.id, repoOwner, repoName);

    // 2. Initialize Check Run
    checkRunId = await github.createCheckRun(token, repoOwner, repoName, headSha);

    // 3. Fetch PR diff text
    const diff = await github.getPRDiff(token, repoOwner, repoName, prNumber);

    // 4. Fetch Priority Files at current HEAD
    const files = await github.fetchPriorityFiles(token, repoOwner, repoName, headSha, PRIORITY_PATTERNS);

    // 5. Run Deterministic checks
    const hits = runDeterministicChecks({ files, diff });

    // 6. Memory Recall loop: query memories in Parcle by pattern ID for each check hit
    const patternMatches = await Promise.all(
      hits.map(h => parcle.recallByPattern(h.id, repoFullName))
    );
    const matchedHistory = hits.map((h, idx) => ({
      hit: h,
      memories: patternMatches[idx]
    })).filter(m => m.memories.length > 0);

    // 7. Reasoning loop: feed diff + files + recalled memories to Groq
    const recalledMemoriesList = matchedHistory.flatMap(m => m.memories);
    const analysis = await groq.analyzePR(repoFullName, prNumber, prTitle, diff, files, recalledMemoriesList);

    // 8. Apply Clamping / Penalties to create hybrid scores
    const { dimensions, penaltiesByDimension } = applyPenalties(analysis.dimensions, hits);
    
    // Weighted scoring formula
    const overallScore = Math.round(
      (dimensions.security * 0.30) +
      (dimensions.reliability * 0.25) +
      (dimensions.observability * 0.15) +
      (dimensions.performance * 0.15) +
      (dimensions.deployment * 0.15)
    );

    // 9. Store Scan results in database
    await db.upsertPR({
      id: prId,
      repo_id: repository.id,
      pr_number: prNumber,
      title: prTitle,
      state: 'open',
      overall_score: overallScore,
      security_score: dimensions.security,
      reliability_score: dimensions.reliability,
      observability_score: dimensions.observability,
      performance_score: dimensions.performance,
      deployment_score: dimensions.deployment
    });

    await db.clearPRRuleHits(prId);
    for (const hit of hits) {
      await db.insertRuleHit({
        id: `${prId}:${hit.id}`,
        pr_id: prId,
        rule_id: hit.id,
        dimension: hit.dimension,
        penalty: hit.penalty,
        title: hit.title,
        description: hit.description
      });
    }

    await db.clearPRRisks(prId);
    for (const risk of analysis.risks) {
      await db.insertRisk({
        id: `${prId}:${crypto.randomUUID()}`,
        pr_id: prId,
        pattern_id: risk.id,
        title: risk.title,
        location: risk.location,
        why: risk.why,
        severity: risk.severity
      });
    }

    // Update repository current score
    await db.updateRepoScore(repository.id, overallScore);

    // 10. Store patterns back in Memory (Recall -> Reason -> Store loop)
    for (const risk of analysis.risks) {
      // Store in memory tagged with pattern_id and repo name
      await parcle.storePattern(
        `[PR #${prNumber}] Detected ${risk.severity} risk: "${risk.title}" in ${risk.location}. ${risk.why}`,
        risk.id,
        repoFullName,
        { prNumber, tags: [risk.severity] }
      );
    }

    // 11. Format & Post Check Run and Comments
    const patternSection = buildPatternMatchSection(matchedHistory);
    const commentMarkdown = buildPRComment(
      prNumber,
      overallScore,
      dimensions,
      penaltiesByDimension,
      analysis.risks,
      patternSection,
      analysis.summary
    );

    // Post to PR
    await github.postPRComment(token, repoOwner, repoName, prNumber, commentMarkdown);

    // Complete Check Run
    const conclusion = overallScore >= 70 ? 'success' : 'failure';
    await github.updateCheckRun(token, repoOwner, repoName, checkRunId, 'completed', conclusion, {
      title: `Sentinel PR Audit Score: ${overallScore}/100`,
      summary: analysis.summary,
      text: commentMarkdown
    });

    // 12. Create GitHub Issue if critical risk detected
    const criticalRisks = analysis.risks.filter(r => r.severity === 'critical');
    for (const crit of criticalRisks) {
      await github.createIssue(token, repoOwner, repoName, prNumber, crit);
    }

    console.log(`PR #${prNumber} successfully audited. Final Score: ${overallScore}`);
  } catch (err) {
    console.error(`Error processing PR audit for #${prNumber}:`, err);
    if (checkRunId && token) {
      await github.updateCheckRun(token, repoOwner, repoName, checkRunId, 'completed', 'neutral', {
        title: 'Sentinel PR Audit Failed',
        summary: 'An error occurred while executing the reasoning/rules checks.',
        text: `Error details:\n${err instanceof Error ? err.stack || err.message : String(err)}`
      });
    }
  }
}

// Functions to load frontend files served by Worker
async function fetchDashboardHtml(env: Env): Promise<string> {
  // We can write index.html later and keep it as static asset inside code, or read it if available.
  // For safety, we will let index.html be generated in a file and we can read it.
  // If we compile/deploy, we can bundle it. In Cloudflare Workers, we can read it using a fallback or bundler.
  // Wait! In development, it's best if we write a helper that reads c:/sentinel/src/frontend/index.html or uses an embedded fallback.
  // Since we have filesystem access, wait, Cloudflare Worker does not have filesystem access at runtime!
  // BUT the worker will be compiled by Wrangler. We can embed the files as raw strings in our TypeScript files, OR
  // wrangler supports linking text files as ES Modules, e.g. `import html from './frontend/index.html';`.
  // Wait, does Wrangler support importing raw HTML? Yes! `import html from './frontend/index.html';` works if Wrangler is configured,
  // or we can write a simple module that exports the strings, or read them directly at build time.
  // To avoid Wrangler compiler issues, we can import them from a `src/frontend_assets.ts` file that holds the code!
  // This is 100% reliable, compile-safe, runs on any Cloudflare Worker version, and has zero config overhead!
  // Let's import the assets from `src/frontend_assets.ts`.
  try {
    const assets = await import('./frontend_assets');
    return assets.HTML;
  } catch (e) {
    return `<h1>Sentinel Dashboard Loading Error</h1><p>${String(e)}</p>`;
  }
}

async function fetchDashboardCss(): Promise<string> {
  try {
    const assets = await import('./frontend_assets');
    return assets.CSS;
  } catch (e) {
    return 'body { background: #000; color: #fff; }';
  }
}

async function fetchDashboardJs(): Promise<string> {
  try {
    const assets = await import('./frontend_assets');
    return assets.JS;
  } catch (e) {
    return 'console.error("Dashboard script missing");';
  }
}
