import jwt from '@tsndr/cloudflare-worker-jwt';
import { DbHelper } from './db';
import { runDeterministicChecks, applyPenalties, extractRepositoryFacts, scoreFromFacts, calculateOverallScore } from './rules';
import { ParcleClient } from './parcle';
import { GroqEngine, AnalysisResult } from './groq';
import { GitHubClient, verifyWebhookSignature, buildPRComment, buildPatternMatchSection } from './github';

export interface Env {
  DB: any; // D1Database
  GROQ_API_KEY?: string;
  PARCLE_API_KEY?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string; // PEM format
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  JWT_SECRET?: string;
}

interface UserSession {
  login: string;
  id: number;
  accessToken: string;
}

async function getUserSession(request: Request, env: Env): Promise<UserSession | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.substring(7);
  const jwtSecret = env.JWT_SECRET || 'sentinel-jwt-secret-fallback';
  try {
    const isValid = await jwt.verify(token, jwtSecret);
    if (!isValid) return null;
    const decoded = jwt.decode(token);
    return decoded.payload as UserSession;
  } catch (e) {
    return null;
  }
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
      // 1.1 Config Endpoint
      if (path === '/api/config' && request.method === 'GET') {
        return new Response(JSON.stringify({ client_id: env.GITHUB_CLIENT_ID }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      // 1.2 GitHub OAuth authentication
      if (path === '/api/auth/github' && request.method === 'POST') {
        const body = await request.json() as any;
        const { code } = body;
        if (!code) {
          return new Response(JSON.stringify({ error: 'Missing code' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        // Exchange code for user access token
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Sentinel-App'
          },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code
          })
        });

        const tokenData = await tokenRes.json() as any;
        const accessToken = tokenData.access_token;
        if (!accessToken) {
          return new Response(JSON.stringify({ error: tokenData.error_description || 'OAuth token exchange failed' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        // Fetch user info from GitHub
        const userRes = await fetch('https://api.github.com/user', {
          headers: {
            'Authorization': `token ${accessToken}`,
            'User-Agent': 'Sentinel-App'
          }
        });

        if (!userRes.ok) {
          return new Response(JSON.stringify({ error: 'Failed to fetch user profile' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        const userData = await userRes.json() as any;
        const login = userData.login;
        const id = userData.id;
        const avatarUrl = userData.avatar_url;

        // Sign user session JWT
        const jwtSecret = env.JWT_SECRET || 'sentinel-jwt-secret-fallback';
        const jwtToken = await jwt.sign({
          login,
          id,
          accessToken,
          exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 // 7 days
        }, jwtSecret, { algorithm: 'HS256' });

        return new Response(JSON.stringify({ token: jwtToken, user: { login, avatar_url: avatarUrl } }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      // 2. API: List Repositories
      if (path === '/api/repos' && request.method === 'GET') {
        const session = await getUserSession(request, env);
        if (!session) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        const repos = await db.listRepos();

        // Query GitHub API for user's repos to verify permissions
        const ghReposRes = await fetch('https://api.github.com/user/repos?per_page=100', {
          headers: {
            'Authorization': `token ${session.accessToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Sentinel-App'
          }
        });

        if (!ghReposRes.ok) {
          return new Response(JSON.stringify({ error: 'Failed to fetch repository access permissions from GitHub' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        const ghRepos = await ghReposRes.json() as any[];
        const allowedRepoIds = new Set(ghRepos.map(r => r.id));
        const filteredRepos = repos.filter(r => allowedRepoIds.has(r.id));

        return new Response(JSON.stringify(filteredRepos), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      // 3. API: Repository Detail
      const repoMatch = path.match(/^\/api\/repos\/([^\/]+)\/([^\/]+)$/);
      if (repoMatch && request.method === 'GET') {
        const owner = repoMatch[1];
        const name = repoMatch[2];

        const session = await getUserSession(request, env);
        if (!session) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        // Validate repository access on GitHub
        const accessRes = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
          headers: {
            'Authorization': `token ${session.accessToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Sentinel-App'
          }
        });

        if (!accessRes.ok) {
          return new Response(JSON.stringify({ error: 'Forbidden: You do not have access to this repository on GitHub' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

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

      // 4. API: PR/Commit scan details
      const prMatch = path.match(/^\/api\/repos\/([^\/]+)\/([^\/]+)\/pr\/(-?\d+)$/);
      if (prMatch && request.method === 'GET') {
        const owner = prMatch[1];
        const name = prMatch[2];
        const prNumber = parseInt(prMatch[3]);

        const session = await getUserSession(request, env);
        if (!session) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        // Validate repository access on GitHub
        const accessRes = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
          headers: {
            'Authorization': `token ${session.accessToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Sentinel-App'
          }
        });

        if (!accessRes.ok) {
          return new Response(JSON.stringify({ error: 'Forbidden: You do not have access to this repository on GitHub' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

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
          hits.map(h => parcle.recallByPattern(h.rule_id, `${owner}/${name}`, 4, prNumber))
        );
        const matchedHistory = hits.map((h, i) => ({
          hit: { id: h.rule_id, title: h.title },
          memories: patternMatches[i]
        })).filter(m => m.memories.length > 0);

        return new Response(JSON.stringify({ pr, ruleHits: hits, risks, patternMatches: matchedHistory }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      // 4.1 API: Get repository Parcle memories
      const memoriesMatch = path.match(/^\/api\/repos\/([^\/]+)\/([^\/]+)\/memories$/);
      if (memoriesMatch && request.method === 'GET') {
        const owner = memoriesMatch[1];
        const name = memoriesMatch[2];

        const session = await getUserSession(request, env);
        if (!session) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        // Validate repository access on GitHub
        const accessRes = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
          headers: {
            'Authorization': `token ${session.accessToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Sentinel-App'
          }
        });

        if (!accessRes.ok) {
          return new Response(JSON.stringify({ error: 'Forbidden: You do not have access to this repository on GitHub' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        const parcle = new ParcleClient(env.PARCLE_API_KEY || null, env.DB);
        const memories = await parcle.recallByRepo(`${owner}/${name}`, 50);

        return new Response(JSON.stringify({ memories }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      // 5. API: Activate Enter Pro
      if (path === '/api/pro/activate' && request.method === 'POST') {
        const session = await getUserSession(request, env);
        if (!session) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        const body = await request.json() as any;
        const { owner, repo, licenseKey } = body;
        if (!owner || !repo || !licenseKey) {
          return new Response(JSON.stringify({ error: 'Missing parameters' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        // Validate repository access on GitHub
        const accessRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
          headers: {
            'Authorization': `token ${session.accessToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Sentinel-App'
          }
        });

        if (!accessRes.ok) {
          return new Response(JSON.stringify({ error: 'Forbidden' }), {
            status: 403,
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

      // 5.1 API: Sync/Scan Repository (Baseline + Commit Scans + Past PRs Backfill)
      const syncMatch = path.match(/^\/api\/repos\/([^\/]+)\/([^\/]+)\/sync$/);
      if (syncMatch && request.method === 'POST') {
        const owner = syncMatch[1];
        const name = syncMatch[2];

        const session = await getUserSession(request, env);
        if (!session) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        // Validate repository access on GitHub
        const accessRes = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
          headers: {
            'Authorization': `token ${session.accessToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Sentinel-App'
          }
        });

        if (!accessRes.ok) {
          return new Response(JSON.stringify({ error: 'Forbidden' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        ctx.waitUntil(runRepositorySync(owner, name, env));
        return new Response(JSON.stringify({
          message: 'Scan queued successfully',
          stages: [
            'GitHub tree discovery',
            'Repository fact extraction',
            'Deterministic rule scoring',
            'Parcle memory recall',
            'Compact Groq baseline reasoning',
            'Scan history update'
          ]
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
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

    // 7. Reasoning loop: feed diff + facts + rule hits + recalled memories to Groq
    const facts = extractRepositoryFacts(files);
    const recalledMemoriesList = matchedHistory.flatMap(m => m.memories);
    const analysis = await groq.analyzePR(repoFullName, prNumber, prTitle, diff, facts, hits, recalledMemoriesList);

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
    for (const hit of hits) {
      await parcle.storePattern(
        `[PR #${prNumber}] Deterministic rule hit: "${hit.title}" in ${repoFullName}. ${hit.description}`,
        hit.id,
        repoFullName,
        { prNumber, tags: [hit.dimension] }
      );
    }

    for (const risk of analysis.risks) {
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

// Background sync worker for already going-on projects (baseline scan + past PR backfill)
async function runRepositorySync(owner: string, repo: string, env: Env) {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    console.error('GITHUB_APP_ID or GITHUB_PRIVATE_KEY is not defined. Cannot sync.');
    return;
  }

  const db = new DbHelper(env.DB);
  const github = new GitHubClient(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);
  const parcle = new ParcleClient(env.PARCLE_API_KEY || null, env.DB);
  const groq = new GroqEngine(env.GROQ_API_KEY || 'dummy_key');
  const repoFullName = `${owner}/${repo}`;

  try {
    console.log(`Starting repository sync for ${repoFullName}...`);
    // 1. Get installation ID for repo
    const installationId = await github.getRepositoryInstallation(owner, repo);
    const token = await github.getInstallationToken(installationId);

    // 2. Fetch repo details (like default branch)
    const repoDetails = await github.getRepositoryDetails(token, owner, repo);
    const defaultBranch = repoDetails.default_branch || 'main';
    const repoId = repoDetails.id;

    // Register / update repository in D1
    await db.upsertRepo(repoId, owner, repo);
    await db.updateRepoScanStatus(repoId, 'scanning', 'Stage 1/7: Discovering GitHub repository structure...');

    // 3. Fetch a capped, representative set of repository files to calculate baseline score.
    // Groq receives facts derived from these files, not their raw contents.
    await db.updateRepoScanStatus(repoId, 'scanning', 'Stage 2/7: Extracting code facts and dependencies...');
    const files = await github.fetchRepositoryScanFiles(token, owner, repo, defaultBranch);
    const facts = extractRepositoryFacts(files);

    await db.updateRepoScanStatus(repoId, 'scanning', 'Stage 3/7: Running deterministic rules engine...');
    const hits = runDeterministicChecks({ files });
    
    // Baseline score calculation
    const deterministicDimensions = scoreFromFacts(hits);
    const fallbackDimensions = { security: 80, reliability: 80, observability: 80, performance: 80, deployment: 80 };
    const overallScore = calculateOverallScore(deterministicDimensions);

    // Update repository current score
    await db.updateRepoScore(repoId, overallScore);
    console.log(`Baseline score for ${repoFullName} computed: ${overallScore}`);

    // Save Baseline PR #0 Scan record in D1 so the dashboard is immediately populated
    const baselinePrId = `${repoFullName}/pull/0`;
    
    await db.updateRepoScanStatus(repoId, 'scanning', 'Stage 4/7: Recalling historical memories from Parcle...');
    const baselineMemories = await parcle.recallByRepo(repoFullName, 3);

    // Query Groq for baseline analysis using compact facts only.
    await db.updateRepoScanStatus(repoId, 'scanning', 'Stage 5/7: Analyzing codebase architecture with Groq reasoning...');
    let baselineAnalysis: AnalysisResult;
    try {
      baselineAnalysis = await groq.analyzeBaseline({
        repoName: repoFullName,
        branch: defaultBranch,
        facts,
        dimensions: deterministicDimensions,
        hits,
        memories: baselineMemories
      });
    } catch (e) {
      console.error(`Groq baseline analysis query failed:`, e);
      baselineAnalysis = {
        dimensions: {
          security: deterministicDimensions.security ?? 80,
          reliability: deterministicDimensions.reliability ?? 80,
          observability: deterministicDimensions.observability ?? 80,
          performance: deterministicDimensions.performance ?? 80,
          deployment: deterministicDimensions.deployment ?? 80
        },
        risks: hits.map(hit => ({
          id: hit.id,
          title: hit.title,
          location: hit.dimension,
          why: hit.description,
          severity: (hit.penalty >= 15 ? 'warning' : 'info') as 'warning' | 'info'
        })),
        summary: 'Baseline posture scan computed deterministic rules checks.'
      };
    }

    const baselineClamped = applyPenalties(baselineAnalysis.dimensions, hits);
    const baselineOverallScore = calculateOverallScore(baselineClamped.dimensions);

    await db.upsertPR({
      id: baselinePrId,
      repo_id: repoId,
      pr_number: 0,
      title: `Baseline Posture Scan (${defaultBranch})`,
      state: 'merged',
      overall_score: baselineOverallScore,
      security_score: baselineClamped.dimensions.security,
      reliability_score: baselineClamped.dimensions.reliability,
      observability_score: baselineClamped.dimensions.observability,
      performance_score: baselineClamped.dimensions.performance,
      deployment_score: baselineClamped.dimensions.deployment
    });

    // Insert baseline rule hits
    await db.clearPRRuleHits(baselinePrId);
    for (const hit of hits) {
      await db.insertRuleHit({
        id: `${baselinePrId}:${hit.id}`,
        pr_id: baselinePrId,
        rule_id: hit.id,
        dimension: hit.dimension,
        penalty: hit.penalty,
        title: hit.title,
        description: hit.description
      });
    }

    // Insert baseline risks
    await db.clearPRRisks(baselinePrId);
    for (const risk of baselineAnalysis.risks) {
      await db.insertRisk({
        id: `${baselinePrId}:${crypto.randomUUID()}`,
        pr_id: baselinePrId,
        pattern_id: risk.id,
        title: risk.title,
        location: risk.location,
        why: risk.why,
        severity: risk.severity
      });
    }

    for (const hit of hits) {
      await parcle.storePattern(
        `[Baseline] ${hit.title}: ${hit.description} Dimension ${hit.dimension} lost ${hit.penalty} points. Scanned ${facts.scannedFileCount} files.`,
        hit.id,
        repoFullName,
        { prNumber: 0, tags: ['baseline', hit.dimension] }
      );
    }

    // Post the Baseline Report as a GitHub Issue in the repository (Option A)
    try {
      await github.createBaselineReportIssue(
        token,
        owner,
        repo,
        baselineOverallScore,
        hits,
        baselineAnalysis.risks,
        baselineAnalysis.summary
      );
      console.log(`Baseline report issue created in GitHub for ${repoFullName}`);
    } catch (issueErr) {
      console.error(`Failed to create baseline report issue:`, issueErr);
    }

    // Fetch recent commits and backfill them as commit scans in D1
    try {
      console.log(`Fetching recent commits for ${repoFullName} to populate commit scan history...`);
      const commits = await github.getRecentCommits(token, owner, repo, 30);
      console.log(`Found ${commits.length} commits to backfill.`);

      for (let i = 0; i < commits.length; i++) {
        const commitObj = commits[i];
        const sha = commitObj.sha;
        const shortSha = sha.substring(0, 7);
        const commitMessage = commitObj.commit.message.split('\n')[0];
        const commitPrNumber = -(i + 1); // -1, -2, -3, -4, -5
        const commitPrId = `${repoFullName}/pull/${commitPrNumber}`;
        const commitPrTitle = `Commit [${shortSha}]: ${commitMessage}`;

        const progressMessage = `Stage 6/7: Backfilling history - scanning commit [${shortSha}] ("${commitMessage}")...`;
        await db.updateRepoScanStatus(repoId, 'scanning', progressMessage);
        console.log(`Backfilling commit scan ${shortSha} ("${commitMessage}")...`);

        try {
          // Fetch commit diff
          const diffRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}`, {
            headers: {
              'Authorization': `token ${token}`,
              'Accept': 'application/vnd.github.v3.diff',
              'User-Agent': 'Sentinel-App'
            }
          });
          const diff = diffRes.ok ? await diffRes.text() : '';

          // Fetch priority files at commit ref
          const commitFiles = await github.fetchPriorityFiles(token, owner, repo, sha, PRIORITY_PATTERNS);

          // Run checks
          const commitHits = runDeterministicChecks({ files: commitFiles, diff });
          const commitFacts = extractRepositoryFacts(commitFiles);

          // Groq analysis
          let commitAnalysis: AnalysisResult;
          try {
            commitAnalysis = await groq.analyzePR(
              repoFullName,
              commitPrNumber,
              commitPrTitle,
              diff,
              commitFacts,
              commitHits,
              []
            );
          } catch (e) {
            commitAnalysis = {
              dimensions: fallbackDimensions,
              risks: [],
              summary: 'Commit scan completed deterministic checks.'
            };
          }

          const commitClamped = applyPenalties(commitAnalysis.dimensions, commitHits);
          const commitOverallScore = Math.round(
            (commitClamped.dimensions.security * 0.30) +
            (commitClamped.dimensions.reliability * 0.25) +
            (commitClamped.dimensions.observability * 0.15) +
            (commitClamped.dimensions.performance * 0.15) +
            (commitClamped.dimensions.deployment * 0.15)
          );

          await db.upsertPR({
            id: commitPrId,
            repo_id: repoId,
            pr_number: commitPrNumber,
            title: commitPrTitle,
            state: 'merged',
            overall_score: commitOverallScore,
            security_score: commitClamped.dimensions.security,
            reliability_score: commitClamped.dimensions.reliability,
            observability_score: commitClamped.dimensions.observability,
            performance_score: commitClamped.dimensions.performance,
            deployment_score: commitClamped.dimensions.deployment
          });

          // Insert rule hits
          await db.clearPRRuleHits(commitPrId);
          for (const hit of commitHits) {
            await db.insertRuleHit({
              id: `${commitPrId}:${hit.id}`,
              pr_id: commitPrId,
              rule_id: hit.id,
              dimension: hit.dimension,
              penalty: hit.penalty,
              title: hit.title,
              description: hit.description
            });
          }

          // Insert risks
          await db.clearPRRisks(commitPrId);
          for (const risk of commitAnalysis.risks) {
            await db.insertRisk({
              id: `${commitPrId}:${crypto.randomUUID()}`,
              pr_id: commitPrId,
              pattern_id: risk.id,
              title: risk.title,
              location: risk.location,
              why: risk.why,
              severity: risk.severity
            });
          }

          // Learn patterns from commits
          for (const risk of commitAnalysis.risks) {
            await parcle.storePattern(
              `[Commit ${shortSha}] Detected ${risk.severity} risk: "${risk.title}" in ${risk.location}. ${risk.why}`,
              risk.id,
              repoFullName,
              { prNumber: commitPrNumber, tags: [risk.severity] }
            );
          }
        } catch (commitErr) {
          console.error(`Failed to backfill commit ${shortSha}:`, commitErr);
        }
      }
    } catch (commitsErr) {
      console.error(`Failed to fetch recent commits:`, commitsErr);
    }

    // 4. Fetch last 5 pull requests (closed, merged, or open)
    const pastPRs = await github.getPastPullRequests(token, owner, repo, 5);
    console.log(`Found ${pastPRs.length} past pull requests to backfill.`);

    for (const pr of pastPRs) {
      const prNumber = pr.number;
      const prTitle = pr.title;
      const prState = pr.state;
      const headSha = pr.head.sha;
      const prId = `${repoFullName}/pull/${prNumber}`;

      const progressMessage = `Stage 6/7: Backfilling history - scanning PR #${prNumber} ("${prTitle}")...`;
      await db.updateRepoScanStatus(repoId, 'scanning', progressMessage);
      console.log(`Backfilling PR #${prNumber} ("${prTitle}") at SHA ${headSha}...`);

      try {
        // Fetch PR diff
        const diff = await github.getPRDiff(token, owner, repo, prNumber);

        // Fetch Priority Files at PR HEAD
        const prFiles = await github.fetchPriorityFiles(token, owner, repo, headSha, PRIORITY_PATTERNS);

        // Run Deterministic checks
        const prHits = runDeterministicChecks({ files: prFiles, diff });
        const prFacts = extractRepositoryFacts(prFiles);

        // Memory Recall loop
        const patternMatches = await Promise.all(
          prHits.map(h => parcle.recallByPattern(h.id, repoFullName))
        );
        const matchedHistory = prHits.map((h, idx) => ({
          hit: h,
          memories: patternMatches[idx]
        })).filter(m => m.memories.length > 0);

        // Reasoning loop (Groq)
        const recalledMemoriesList = matchedHistory.flatMap(m => m.memories);
        const analysis = await groq.analyzePR(repoFullName, prNumber, prTitle, diff, prFacts, prHits, recalledMemoriesList);

        // Apply clamping
        const clamped = applyPenalties(analysis.dimensions, prHits);
        const prScore = Math.round(
          (clamped.dimensions.security * 0.30) +
          (clamped.dimensions.reliability * 0.25) +
          (clamped.dimensions.observability * 0.15) +
          (clamped.dimensions.performance * 0.15) +
          (clamped.dimensions.deployment * 0.15)
        );

        // Save PR scan record in D1
        await db.upsertPR({
          id: prId,
          repo_id: repoId,
          pr_number: prNumber,
          title: prTitle,
          state: prState,
          overall_score: prScore,
          security_score: clamped.dimensions.security,
          reliability_score: clamped.dimensions.reliability,
          observability_score: clamped.dimensions.observability,
          performance_score: clamped.dimensions.performance,
          deployment_score: clamped.dimensions.deployment
        });

        // Insert rule hits
        await db.clearPRRuleHits(prId);
        for (const hit of prHits) {
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

        // Insert predicted risks
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

        // Store risks in Parcle Memory (learning from past PRs too!)
        for (const risk of analysis.risks) {
          await parcle.storePattern(
            `[PR #${prNumber}] Detected ${risk.severity} risk: "${risk.title}" in ${risk.location}. ${risk.why}`,
            risk.id,
            repoFullName,
            { prNumber, tags: [risk.severity] }
          );
        }

        console.log(`PR #${prNumber} backfill complete. Score: ${prScore}`);
      } catch (prErr) {
        console.error(`Failed to backfill PR #${prNumber}:`, prErr);
      }
    }

    await db.updateRepoScanStatus(repoId, 'completed', 'Scan completed successfully.');
    console.log(`Repository sync for ${repoFullName} completed successfully.`);
  } catch (err) {
    console.error(`Repository sync failed for ${repoFullName}:`, err);
    try {
      const repoObj = await db.getRepo(owner, repo);
      if (repoObj) {
        await db.updateRepoScanStatus(repoObj.id, 'failed', `Scan failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (dbErr) {
      console.error('Failed to write failure status to DB:', dbErr);
    }
  }
}
