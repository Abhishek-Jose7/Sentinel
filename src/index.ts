import jwt from '@tsndr/cloudflare-worker-jwt';
import { DbHelper } from './db';
import { runDeterministicChecks, applyPenalties, extractRepositoryFacts, scoreFromFacts, calculateOverallScore } from './rules';
import { VercelClient } from './vercel';
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
  VERCEL_CLIENT_ID?: string;
  VERCEL_CLIENT_SECRET?: string;
  VERCEL_REDIRECT_URI?: string;
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

      // 1.15 Test Groq Endpoint
      if (path === '/api/test-groq' && request.method === 'GET') {
        const groqKey = env.GROQ_API_KEY;
        if (!groqKey) {
          return new Response(JSON.stringify({ error: 'GROQ_API_KEY is not defined in environment' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }
        try {
          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${groqKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'llama-3.1-8b-instant',
              messages: [
                { role: 'user', content: 'Say "Groq Llama 3.1 8B Instant is successfully responding!"' }
              ],
              temperature: 0.1
            })
          });
          const status = res.status;
          const text = await res.text();
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch(e) {
            parsed = text;
          }
          return new Response(JSON.stringify({ status, response: parsed }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }
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

      // 1.3 Vercel OAuth Initiate Connection Redirect
      if (path === '/api/auth/vercel/connect' && request.method === 'GET') {
        const token = url.searchParams.get('token');
        if (!token) {
          return new Response('Missing JWT token', { status: 400 });
        }
        const clientId = env.VERCEL_CLIENT_ID || '';
        const redirectUri = env.VERCEL_REDIRECT_URI || `${url.origin}/api/auth/vercel/callback`;
        const vercelAuthUrl = `https://vercel.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(token)}`;
        return Response.redirect(vercelAuthUrl, 302);
      }

      // 1.4 Vercel OAuth Callback (handles token exchange and connection storage)
      if (path === '/api/auth/vercel/callback' && request.method === 'GET') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');

        if (!code || !state) {
          const oauthError = url.searchParams.get('error');
          const oauthErrorDesc = url.searchParams.get('error_description');
          if (oauthError) {
            return new Response(`Vercel OAuth Error: ${oauthError} (${oauthErrorDesc || 'No description'})`, { status: 400 });
          }
          return new Response(`Missing code or state parameters. (URL Query: ${url.search})`, { status: 400 });
        }

        // Verify state (GitHub JWT)
        const jwtSecret = env.JWT_SECRET || 'sentinel-jwt-secret-fallback';
        let session: UserSession | null = null;
        try {
          const isValid = await jwt.verify(state, jwtSecret);
          if (isValid) {
            const decoded = jwt.decode(state);
            session = decoded.payload as UserSession;
          }
        } catch (e) {
          console.error('Vercel state verification failed:', e);
        }

        if (!session) {
          return new Response('Unauthorized: Invalid state parameter', { status: 401 });
        }

        try {
          const currentRedirectUri = env.VERCEL_REDIRECT_URI || `${url.origin}/api/auth/vercel/callback`;
          const vercel = new VercelClient();
          const { access_token, user_id, team_id } = await vercel.exchangeOAuthCode(
            code,
            env.VERCEL_CLIENT_ID || '',
            env.VERCEL_CLIENT_SECRET || '',
            currentRedirectUri
          );

          await db.upsertVercelConnection(session.login, access_token, team_id);

          return new Response(`
            <!DOCTYPE html>
            <html>
              <head>
                <title>Vercel Connected</title>
                <script>
                  if (window.opener) {
                    window.opener.postMessage({ type: 'vercel-connected' }, '*');
                  }
                  window.close();
                </script>
              </head>
              <body style="background: #0d1117; color: #fff; font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; flex-direction: column;">
                <h2 style="color: #00FF66; margin-bottom: 8px;">✓ Vercel Connected Successfully!</h2>
                <p style="color: #8b949e;">This popup window will close automatically.</p>
              </body>
            </html>
          `, { headers: { 'Content-Type': 'text/html' } });
        } catch (err) {
          console.error('Vercel OAuth exchange error:', err);
          return new Response(`Vercel connection failed: ${err instanceof Error ? err.message : String(err)}`, { status: 500 });
        }
      }

      // 1.5 Vercel List Projects
      if (path === '/api/vercel/projects' && request.method === 'GET') {
        const session = await getUserSession(request, env);
        if (!session) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        const conn = await db.getVercelConnection(session.login);
        if (!conn) {
          return new Response(JSON.stringify({ projects: [], connected: false }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        try {
          const client = new VercelClient(conn.access_token, conn.team_id);
          const projects = await client.fetchProjects();
          return new Response(JSON.stringify({ projects, connected: true }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        } catch (e) {
          console.error('Error fetching Vercel projects:', e);
          return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }
      }

      // 1.6 Link Vercel Project to Repo
      const linkVercelMatch = path.match(/^\/api\/repos\/([^\/]+)\/([^\/]+)\/vercel$/);
      if (linkVercelMatch && request.method === 'POST') {
        const owner = linkVercelMatch[1];
        const name = linkVercelMatch[2];

        const session = await getUserSession(request, env);
        if (!session) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
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

        const { projectId, projectName } = await request.json() as any;
        if (!projectId || !projectName) {
          return new Response(JSON.stringify({ error: 'Missing projectId or projectName' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }

        await db.upsertVercelProject(repo.id, projectId, projectName);

        // Trigger codebase sync (background routine) to compute Vercel metrics
        ctx.waitUntil(runRepositorySync(owner, name, env, session.accessToken));

        return new Response(JSON.stringify({ message: 'Vercel project linked successfully' }), {
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

        // Helper to fetch all paginated items from a GitHub API endpoint
        async function fetchAllGitHubPages(url: string, token: string): Promise<any[]> {
          let results: any[] = [];
          let nextUrl: string | null = url;

          while (nextUrl) {
            const res: Response = await fetch(nextUrl, {
              headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'Sentinel-App'
              }
            });

            if (!res.ok) {
              console.error(`Failed to fetch page ${nextUrl}: ${res.status}`);
              break;
            }

            const data = await res.json() as any;
            if (Array.isArray(data)) {
              results = results.concat(data);
            } else if (data && Array.isArray(data.repositories)) {
              results = results.concat(data.repositories);
            } else {
              break;
            }

            const linkHeader: string = res.headers.get('Link') || '';
            const nextMatch: RegExpMatchArray | null = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            nextUrl = nextMatch ? nextMatch[1] : null;
          }

          return results;
        }

        const allowedRepoIds = new Set<number>();
        const repos = await db.listRepos();
        const existingRepoIds = new Set(repos.map(r => r.id));
        const discoveredRepos = new Map<number, { id: number; owner: string; name: string }>();

        // Run all API discovery steps in parallel to save time
        await Promise.all([
          // 1. Auto-discover installations and their repositories
          (async () => {
            try {
              const installationsRes = await fetch('https://api.github.com/user/installations', {
                headers: {
                  'Authorization': `token ${session.accessToken}`,
                  'Accept': 'application/vnd.github.v3+json',
                  'User-Agent': 'Sentinel-App'
                }
              });

              if (installationsRes.ok) {
                const instData = await installationsRes.json() as any;
                const installations = instData.installations || [];
                
                await Promise.all(installations.map(async (inst: any) => {
                  try {
                    const instRepos = await fetchAllGitHubPages(`https://api.github.com/user/installations/${inst.id}/repositories?per_page=100`, session.accessToken);
                    for (const r of instRepos) {
                      allowedRepoIds.add(r.id);
                      discoveredRepos.set(r.id, { id: r.id, owner: r.owner.login, name: r.name });
                    }
                  } catch (e) {
                    console.error(`Error auto-fetching repos for installation ${inst.id}:`, e);
                  }
                }));
              }
            } catch (err) {
              console.error('Error auto-discovering installations:', err);
            }
          })(),

          // 2. Fallback / additional user repos to ensure direct permissions
          (async () => {
            try {
              const ghRepos = await fetchAllGitHubPages('https://api.github.com/user/repos?per_page=100', session.accessToken);
              for (const r of ghRepos) {
                allowedRepoIds.add(r.id);
                discoveredRepos.set(r.id, { id: r.id, owner: r.owner.login, name: r.name });
              }
            } catch (err) {
              console.error('Error auto-fetching direct user repos:', err);
            }
          })(),

          // 3. Extra Fallback: Fetch public repositories for user directly
          (async () => {
            try {
              const publicRepos = await fetchAllGitHubPages(`https://api.github.com/users/${session.login}/repos?per_page=100`, session.accessToken);
              for (const r of publicRepos) {
                allowedRepoIds.add(r.id);
                discoveredRepos.set(r.id, { id: r.id, owner: r.owner.login, name: r.name });
              }
            } catch (err) {
              console.error('Error auto-fetching public repos fallback:', err);
            }
          })(),

          // 4. Org Repos discovery fallback
          (async () => {
            try {
              const orgsRes = await fetch('https://api.github.com/user/orgs', {
                headers: {
                  'Authorization': `token ${session.accessToken}`,
                  'Accept': 'application/vnd.github.v3+json',
                  'User-Agent': 'Sentinel-App'
                }
              });

              if (orgsRes.ok) {
                const orgs = await orgsRes.json() as any[];
                await Promise.all(orgs.map(async (org: any) => {
                  try {
                    const orgRepos = await fetchAllGitHubPages(`https://api.github.com/orgs/${org.login}/repos?per_page=100`, session.accessToken);
                    for (const r of orgRepos) {
                      allowedRepoIds.add(r.id);
                      discoveredRepos.set(r.id, { id: r.id, owner: r.owner.login, name: r.name });
                    }
                  } catch (e) {
                    console.error(`Error auto-fetching repos for org ${org.login}:`, e);
                  }
                }));
              }
            } catch (err) {
              console.error('Error auto-discovering org installations:', err);
            }
          })()
        ]);

        const upsertPromises: Promise<void>[] = [];
        let newReposCount = 0;
        for (const [id, r] of discoveredRepos.entries()) {
          if (!existingRepoIds.has(id)) {
            newReposCount++;
            upsertPromises.push((async () => {
              await db.upsertRepo(r.id, r.owner, r.name);
              // Trigger background sync for the first new repo found
              if (newReposCount === 1) {
                ctx.waitUntil(runRepositorySync(r.owner, r.name, env, session.accessToken));
              }
            })());
          }
        }
        if (upsertPromises.length > 0) {
          await Promise.all(upsertPromises);
        }

        const reposList = await db.listRepos();
        const filteredRepos = reposList.filter(r => 
          allowedRepoIds.has(r.id) || 
          r.owner.toLowerCase() === session.login.toLowerCase()
        );

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

        const vercelProject = await db.getVercelProject(repo.id);
        const vercelSnapshot = await db.getLatestDeploymentSnapshot(repo.id);

        return new Response(JSON.stringify({ 
          pr, 
          ruleHits: hits, 
          risks, 
          patternMatches: matchedHistory,
          vercelProject,
          vercelSnapshot
        }), {
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

        ctx.waitUntil(runRepositorySync(owner, name, env, session.accessToken));
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

    // 4. Fetch Priority Files at current HEAD (filtered by recursive git tree to save subrequests)
    const files = await github.fetchExistingPriorityFiles(token, repoOwner, repoName, headSha, PRIORITY_PATTERNS);

    // 5. Run Deterministic checks
    const hits = runDeterministicChecks({ files, diff });

    // 6. Memory Recall loop: query memories in Parcle by pattern ID for each check hit (limited to 1 to minimize subrequests)
    const patternMatches = await Promise.all(
      hits.map(h => parcle.recallByPattern(h.id, repoFullName, 1))
    );
    const matchedHistory = hits.map((h, idx) => ({
      hit: h,
      memories: patternMatches[idx]
    })).filter(m => m.memories.length > 0);

    // 7. Check Vercel project linkage and fetch latest deployment snapshot
    const vercelProject = await db.getVercelProject(repository.id);
    let vercelSnapshot = null;
    let deploymentHealthScore: number | null = null;
    let deploymentMetrics = undefined;

    if (vercelProject) {
      vercelSnapshot = await db.getLatestDeploymentSnapshot(repository.id);
      if (vercelSnapshot) {
        deploymentHealthScore = vercelSnapshot.score;
        deploymentMetrics = {
          success_rate: vercelSnapshot.success_rate,
          failed_count: vercelSnapshot.failed_count,
          last_status: vercelSnapshot.last_status,
          deploys_7d: vercelSnapshot.deploys_7d,
          deploys_30d: vercelSnapshot.deploys_30d
        };
      }
    }

    // 8. Reasoning loop: feed diff + facts + rule hits + recalled memories + deployment metrics to Groq
    const facts = extractRepositoryFacts(files);
    const recalledMemoriesList = matchedHistory.flatMap(m => m.memories);
    const analysis = await groq.analyzePR(repoFullName, prNumber, prTitle, diff, facts, hits, recalledMemoriesList, deploymentMetrics);

    // 9. Apply Clamping / Penalties to create hybrid scores
    const { dimensions, penaltiesByDimension } = applyPenalties(analysis.dimensions, hits);
    
    // Weighted scoring formula
    const overallScore = Math.round(
      (dimensions.security * 0.30) +
      (dimensions.reliability * 0.25) +
      (dimensions.observability * 0.15) +
      (dimensions.performance * 0.15) +
      (dimensions.deployment * 0.15)
    );

    const combinedScore = deploymentHealthScore !== null 
      ? Math.round(overallScore * 0.6 + deploymentHealthScore * 0.4) 
      : overallScore;

    // 10. Store Scan results in database
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
      deployment_score: dimensions.deployment,
      thought_process: analysis.summary ? `SUMMARY: ${analysis.summary}\n\nTHOUGHT PROCESS:\n${analysis.thought_process || ''}` : (analysis.thought_process || null),
      deployment_health_score: deploymentHealthScore,
      combined_score: combinedScore,
      predicted_failure_point: analysis.predicted_failure_point || null,
      predicted_failure_why: analysis.predicted_failure_why || null,
      predicted_failure_impact: analysis.predicted_failure_impact || null,
      predicted_failure_confidence: analysis.predicted_failure_confidence || null,
      recommended_fixes: analysis.recommended_fixes ? JSON.stringify(analysis.recommended_fixes) : null
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

    // Update repository current score, deployment score, and combined score
    await db.updateRepoScore(repository.id, overallScore, deploymentHealthScore, combinedScore);

    // 11. Store patterns back in Memory (Recall -> Reason -> Store loop)
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

    // 12. Format & Post Check Run and Comments
    const patternSection = buildPatternMatchSection(matchedHistory);
    const commentMarkdown = buildPRComment(
      prNumber,
      overallScore,
      dimensions,
      penaltiesByDimension,
      analysis.risks,
      patternSection,
      analysis.summary,
      analysis.predicted_failure_point,
      analysis.predicted_failure_why,
      analysis.predicted_failure_impact,
      analysis.predicted_failure_confidence,
      analysis.recommended_fixes,
      deploymentHealthScore,
      combinedScore
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
async function runRepositorySync(owner: string, repo: string, env: Env, userAccessToken?: string) {
  const startTime = Date.now();
  const db = new DbHelper(env.DB);
  const github = new GitHubClient(env.GITHUB_APP_ID || '', env.GITHUB_PRIVATE_KEY || '');
  const parcle = new ParcleClient(env.PARCLE_API_KEY || null, env.DB);
  const groq = new GroqEngine(env.GROQ_API_KEY || 'dummy_key');
  const repoFullName = `${owner}/${repo}`;

  try {
    console.log(`Starting repository sync for ${repoFullName}...`);
    
    let token = '';
    let repoDetails: any = null;
    let repoId = 0;
    let defaultBranch = 'main';

    if (userAccessToken) {
      token = userAccessToken;
      console.log(`Using user OAuth access token for sync of ${repoFullName}`);
      repoDetails = await github.getRepositoryDetails(token, owner, repo);
      defaultBranch = repoDetails.default_branch || 'main';
      repoId = repoDetails.id;
    } else {
      if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
        console.error('GITHUB_APP_ID or GITHUB_PRIVATE_KEY is not defined. Cannot sync.');
        return;
      }
      // Get installation ID for repo using GitHub App
      const installationId = await github.getRepositoryInstallation(owner, repo);
      token = await github.getInstallationToken(installationId);
      repoDetails = await github.getRepositoryDetails(token, owner, repo);
      defaultBranch = repoDetails.default_branch || 'main';
      repoId = repoDetails.id;
    }

    // Register / update repository in D1
    await db.upsertRepo(repoId, owner, repo);
    // Reset repository scores and delete old PR scans to prevent stale displays
    await db.updateRepoScore(repoId, null, null, null);
    await db.db.prepare('DELETE FROM pull_requests WHERE repo_id = ?').bind(repoId).run();
    await db.updateRepoScanStatus(repoId, 'scanning', 'Stage 1/7: Discovering GitHub repository structure...');

    // 3. Fetch a capped, representative set of repository files to calculate baseline score.
    // Groq receives facts derived from these files, not their raw contents.
    await db.updateRepoScanStatus(repoId, 'scanning', 'Stage 2/7: Extracting code facts and dependencies...');
    const files = await github.fetchRepositoryScanFiles(
      token,
      owner,
      repo,
      defaultBranch,
      12, // Capped to 12 files to fit within subrequest limits
      45000,
      async (filePath) => {
        await db.updateRepoScanStatus(repoId, 'scanning', `Stage 2/7: Analysing ${filePath}...`);
      }
    );
    const facts = extractRepositoryFacts(files);

    await db.updateRepoScanStatus(repoId, 'scanning', 'Stage 3/7: Running deterministic rules engine...');
    const hits = runDeterministicChecks({ files });
    
    // Baseline score calculation
    const deterministicDimensions = scoreFromFacts(hits);
    const overallScore = calculateOverallScore(deterministicDimensions);
    console.log(`Baseline score for ${repoFullName} computed: ${overallScore}`);

    // Check Vercel project linkage and connection
    const project = await db.getVercelProject(repoId);
    let connection = null;
    let deploymentHealthScore: number | null = null;
    let deploymentMetrics = undefined;
    let deploymentsList: any[] = [];

    if (project) {
      // Find any active Vercel connection
      connection = await db.db.prepare('SELECT * FROM vercel_connections LIMIT 1').first();
      if (connection) {
        await db.updateRepoScanStatus(repoId, 'scanning', 'Stage 3.5/7: Scanning Vercel deployments and calculating metrics...');
        try {
          const vercel = new VercelClient(connection.access_token, connection.team_id);
          deploymentsList = await vercel.fetchDeployments(project.project_id);
          const metrics = vercel.calculateDeploymentMetrics(deploymentsList);
          deploymentHealthScore = vercel.calculateDeploymentHealthScore(metrics, deploymentsList);
          deploymentMetrics = metrics;

          // Insert snapshot
          await db.insertDeploymentSnapshot({
            repo_id: repoId,
            project_id: project.project_id,
            success_rate: metrics.success_rate,
            failed_count: metrics.failed_count,
            last_status: metrics.last_status,
            deploys_7d: metrics.deploys_7d,
            deploys_30d: metrics.deploys_30d,
            score: deploymentHealthScore
          });
          console.log(`Vercel deployments scanned. Health Score: ${deploymentHealthScore}`);
        } catch (err) {
          console.error('Failed to sync Vercel metrics:', err);
        }
      }
    }

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
        memories: baselineMemories,
        deploymentMetrics
      });
    } catch (e) {
      console.error(`Groq baseline analysis query failed:`, e);
      baselineAnalysis = {
        dimensions: {
          security: deterministicDimensions.security ?? 100,
          reliability: deterministicDimensions.reliability ?? 100,
          observability: deterministicDimensions.observability ?? 100,
          performance: deterministicDimensions.performance ?? 100,
          deployment: deterministicDimensions.deployment ?? 100
        },
        risks: hits.map(hit => ({
          id: hit.id,
          title: hit.title,
          location: hit.dimension,
          why: hit.description,
          severity: (hit.penalty >= 15 ? 'warning' : 'info') as 'warning' | 'info'
        })),
        summary: 'Baseline posture scan computed deterministic rules checks.',
        thought_process: `Groq baseline analysis execution failed: ${e instanceof Error ? e.message : String(e)}. Executed deterministic checklist analysis.`,
        predicted_failure_point: 'Engineering reliability and security gaps detected.',
        predicted_failure_why: 'Local checks flag several missing posture indicators.',
        predicted_failure_impact: 'Lack of rate limiting and logging puts application availability at risk.',
        predicted_failure_confidence: 60,
        recommended_fixes: hits.map(h => `Add ${h.id.replace('no-', '')}`)
      };
    }

    const baselineClamped = applyPenalties(baselineAnalysis.dimensions, hits);
    const baselineOverallScore = calculateOverallScore(baselineClamped.dimensions);
    const combinedScore = deploymentHealthScore !== null
      ? Math.round(baselineOverallScore * 0.6 + deploymentHealthScore * 0.4)
      : baselineOverallScore;

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
      deployment_score: baselineClamped.dimensions.deployment,
      thought_process: baselineAnalysis.summary ? `SUMMARY: ${baselineAnalysis.summary}\n\nTHOUGHT PROCESS:\n${baselineAnalysis.thought_process || ''}` : (baselineAnalysis.thought_process || null),
      deployment_health_score: deploymentHealthScore,
      combined_score: combinedScore,
      predicted_failure_point: baselineAnalysis.predicted_failure_point || null,
      predicted_failure_why: baselineAnalysis.predicted_failure_why || null,
      predicted_failure_impact: baselineAnalysis.predicted_failure_impact || null,
      predicted_failure_confidence: baselineAnalysis.predicted_failure_confidence || null,
      recommended_fixes: baselineAnalysis.recommended_fixes ? JSON.stringify(baselineAnalysis.recommended_fixes) : null
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

        // Fetch recent commits and backfill them as commit scans in D1 (limit to 3 commits to respect subrequest limits)
    try {
      console.log(`Fetching recent commits for ${repoFullName} to populate commit scan history...`);
      const commits = await github.getRecentCommits(token, owner, repo, 3);
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

          // Run checks using loaded baseline files + commit diff to minimize subrequests
          const commitHits = runDeterministicChecks({ files, diff });

          // Skip Groq analysis for historical backfilled commits to avoid API limits (12k TPM)
          const commitDimensions = scoreFromFacts(commitHits);
          const commitClamped = applyPenalties(commitDimensions, commitHits);
          const commitAnalysis = {
            dimensions: commitClamped.dimensions,
            risks: [] as any[],
            summary: 'Commit scan completed local deterministic posture check.'
          };
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
            deployment_score: commitClamped.dimensions.deployment,
            thought_process: 'Historical commit scan successfully verified against local deterministic rules. Groq LLM reasoning was bypassed to conserve API limits.',
            deployment_health_score: null,
            combined_score: null,
            predicted_failure_point: null,
            predicted_failure_why: null,
            predicted_failure_impact: null,
            predicted_failure_confidence: null,
            recommended_fixes: null
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

          // Learn patterns from commits (skipped in backfill to avoid unnecessary subrequests)
        } catch (commitErr) {
          console.error(`Failed to backfill commit ${shortSha}:`, commitErr);
        }
      }
    } catch (commitsErr) {
      console.error(`Failed to fetch recent commits:`, commitsErr);
    }
    // Fetch last 2 pull requests (closed, merged, or open) to fit within Cloudflare's subrequests limit safely
    const pastPRs = await github.getPastPullRequests(token, owner, repo, 2);
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

        // Run Deterministic checks using loaded baseline files + PR diff to minimize subrequests
        const prHits = runDeterministicChecks({ files, diff });

        // Skip Groq analysis for historical backfilled PRs to avoid API limits (12k TPM)
        const prDimensions = scoreFromFacts(prHits);
        const clamped = applyPenalties(prDimensions, prHits);
        const analysis = {
          dimensions: clamped.dimensions,
          risks: [] as any[],
          summary: 'Historical PR scan completed local deterministic posture check.'
        };
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
          deployment_score: clamped.dimensions.deployment,
          thought_process: 'Historical PR scan successfully verified against local deterministic rules. Groq LLM reasoning was bypassed to conserve API limits.',
          deployment_health_score: null,
          combined_score: null,
          predicted_failure_point: null,
          predicted_failure_why: null,
          predicted_failure_impact: null,
          predicted_failure_confidence: null,
          recommended_fixes: null
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

        console.log(`PR #${prNumber} backfill complete. Score: ${prScore}`);
      } catch (prErr) {
        console.error(`Failed to backfill PR #${prNumber}:`, prErr);
      }
    }

    await db.updateRepoScore(repoId, baselineOverallScore, deploymentHealthScore, combinedScore);
    await db.updateRepoScanStatus(repoId, 'completed', 'Scan completed successfully.');
    const duration = Date.now() - startTime;
    console.log(`Repository sync for ${repoFullName} completed successfully. Sync Metrics: Scanned Files: ${facts.scannedFileCount}, Rule Hits: ${hits.length}, Memories Recalled: ${baselineMemories.length}, Duration: ${duration}ms`);
  } catch (err) {
    console.error(`Repository sync failed for ${repoFullName}:`, err);
    try {
      const repoObj = await db.getRepo(owner, repo);
      if (repoObj) {
        let userFriendlyMessage = err instanceof Error ? err.message : String(err);
        if (userFriendlyMessage.includes('Failed to get repo installation')) {
          userFriendlyMessage = 'Sentinel GitHub App is not installed on this repository. Please configure it under GitHub settings to allow access to private repositories.';
        }
        await db.updateRepoScanStatus(repoObj.id, 'failed', `Scan failed: ${userFriendlyMessage}`);
      }
    } catch (dbErr) {
      console.error('Failed to write failure status to DB:', dbErr);
    }
  }
}
