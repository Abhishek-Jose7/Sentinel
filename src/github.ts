// src/github.ts

import jwt from '@tsndr/cloudflare-worker-jwt';
import { RuleHit } from './rules';
import { Risk } from './groq';
import { PatternMemory } from './parcle';

type PatternMatchHit = Pick<RuleHit, 'id' | 'title'>;

export async function verifyWebhookSignature(body: string, signature: string, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  
  const parts = signature.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') return false;
  const hex = parts[1];
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return false;
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
  const bodyBytes = encoder.encode(body);
  
  return crypto.subtle.verify('HMAC', key, bytes, bodyBytes);
}

export class GitHubClient {
  private appId: string;
  private privateKey: string;

  constructor(appId: string, privateKey: string) {
    this.appId = appId;
    this.privateKey = privateKey.replace(/\\n/g, '\n');
  }

  // Generates JWT to authenticate as a GitHub App
  private async getAppJwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 60,
      exp: now + (10 * 60), // 10 minute expiration
      iss: this.appId
    };

    // Note: Cloudflare Worker native SubtleCrypto signed via @tsndr/cloudflare-worker-jwt
    const token = await jwt.sign(payload, this.privateKey, { algorithm: 'RS256' });
    return token;
  }

  // Gets installation access token
  async getInstallationToken(installationId: number): Promise<string> {
    const appJwt = await this.getAppJwt();
    const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appJwt}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Sentinel-App'
      }
    });

    if (!res.ok) {
      throw new Error(`Failed to get installation token: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as any;
    return data.token;
  }

  // Fetch PR details
  async getPRDetails(token: string, repoOwner: string, repoName: string, prNumber: number) {
    const res = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Sentinel-App'
      }
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch PR details: ${res.status}`);
    }

    return await res.json() as any;
  }

  // Fetch PR diff
  async getPRDiff(token: string, repoOwner: string, repoName: string, prNumber: number): Promise<string> {
    const res = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3.diff',
        'User-Agent': 'Sentinel-App'
      }
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch PR diff: ${res.status}`);
    }

    return await res.text();
  }

  // Fetch a file content at ref
  async getFileContent(token: string, repoOwner: string, repoName: string, path: string, ref: string): Promise<string | null> {
    const url = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${path}?ref=${ref}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3.raw',
        'User-Agent': 'Sentinel-App'
      }
    });

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      console.warn(`Failed to fetch file ${path}: ${res.status}`);
      return null;
    }

    return await res.text();
  }

  // Fetch multiple priority files at a commit ref
  async fetchPriorityFiles(
    token: string,
    repoOwner: string,
    repoName: string,
    ref: string,
    paths: string[],
    onProgress?: (msg: string) => Promise<void>
  ): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    let scannedCount = 0;
    for (const path of paths) {
      const content = await this.getFileContent(token, repoOwner, repoName, path, ref);
      if (content !== null) {
        files[path] = content;
        scannedCount++;
        if (onProgress) {
          await onProgress(`Stage 2/7: Analysing ${path}... (OK)`);
        }
      } else {
        if (onProgress) {
          await onProgress(`Stage 2/7: Analysing ${path}... (FAILED/NOT_FOUND)`);
        }
      }
    }
    if (onProgress) {
      await onProgress(`Stage 2/7: Scan complete. Successfully loaded ${scannedCount} of ${paths.length} files.`);
    }
    return files;
  }

  // Fetch only the priority files that actually exist in the repository tree
  async fetchExistingPriorityFiles(
    token: string,
    repoOwner: string,
    repoName: string,
    ref: string,
    paths: string[],
    onProgress?: (msg: string) => Promise<void>
  ): Promise<Record<string, string>> {
    const treeRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Sentinel-App'
      }
    });

    if (!treeRes.ok) {
      if (onProgress) await onProgress(`Warning: Failed to fetch repository tree (${treeRes.status}). Falling back to fetching priority files directly...`);
      return this.fetchPriorityFiles(token, repoOwner, repoName, ref, paths, onProgress);
    }

    const data = await treeRes.json() as any;
    const tree = Array.isArray(data.tree) ? data.tree : [];
    const existingPaths = new Set(tree.map((item: any) => item.path));

    const pathsToFetch = paths.filter(p => existingPaths.has(p));
    if (onProgress) await onProgress(`Filtered to ${pathsToFetch.length} existing files from tree.`);
    return this.fetchPriorityFiles(token, repoOwner, repoName, ref, pathsToFetch, onProgress);
  }

  async fetchRepositoryScanFiles(
    token: string,
    repoOwner: string,
    repoName: string,
    ref: string,
    maxFiles = 90,
    maxBytesPerFile = 45000,
    onProgress?: (msg: string) => Promise<void>
  ): Promise<Record<string, string>> {
    if (onProgress) await onProgress(`Stage 2/7: Fetching repository tree for ref "${ref}"...`);
    const treeRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Sentinel-App'
      }
    });

    if (!treeRes.ok) {
      if (onProgress) await onProgress(`Stage 2/7: Warning: Failed to fetch repository tree (status ${treeRes.status}). Falling back to priority files list...`);
      return this.fetchPriorityFiles(token, repoOwner, repoName, ref, [
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
      ], onProgress);
    }

    const data = await treeRes.json() as any;
    const tree = Array.isArray(data.tree) ? data.tree : [];
    const paths = tree
      .filter((item: any) => item.type === 'blob' && typeof item.path === 'string')
      .filter((item: any) => this.isScannablePath(item.path) && Number(item.size || 0) <= maxBytesPerFile)
      .sort((a: any, b: any) => this.scanPriority(b.path) - this.scanPriority(a.path))
      .slice(0, maxFiles)
      .map((item: any) => item.path);

    if (onProgress) await onProgress(`Stage 2/7: Discovered ${tree.length} files total. Selected ${paths.length} priority files for posture analysis.`);
    return this.fetchPriorityFiles(token, repoOwner, repoName, ref, paths, onProgress);
  }

  private isScannablePath(path: string): boolean {
    if (/(^|\/)(node_modules|dist|build|coverage|\.next|\.nuxt|vendor|\.git)\//i.test(path)) {
      return false;
    }
    if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|mp4|mov|woff2?|ttf|map)$/i.test(path)) {
      return false;
    }
    return /\.(ts|tsx|js|jsx|mjs|cjs|json|toml|ya?ml|md|sql|env\.example|dockerfile)$/i.test(path)
      || /(^|\/)(Dockerfile|Jenkinsfile|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(path)
      || /^\.github\/workflows\//i.test(path);
  }

  private scanPriority(path: string): number {
    if (/package\.json$|wrangler\.(json|toml)$|tsconfig\.json$|Dockerfile$|\.github\/workflows\//i.test(path)) return 100;
    if (/(src|app|pages|server|api)\//i.test(path)) return 80;
    if (/(test|spec|__tests__)/i.test(path)) return 65;
    if (/\.(md|sql|ya?ml|toml)$/i.test(path)) return 45;
    return 30;
  }

  // Create Check Run
  async createCheckRun(
    token: string,
    repoOwner: string,
    repoName: string,
    headSha: string
  ): Promise<number> {
    const res = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/check-runs`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Sentinel-App'
      },
      body: JSON.stringify({
        name: 'Sentinel PR Audit',
        head_sha: headSha,
        status: 'in_progress',
        started_at: new Date().toISOString()
      })
    });

    if (!res.ok) {
      throw new Error(`Failed to create check run: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as any;
    return data.id;
  }

  // Update Check Run
  async updateCheckRun(
    token: string,
    repoOwner: string,
    repoName: string,
    checkRunId: number,
    status: 'in_progress' | 'completed',
    conclusion?: 'success' | 'failure' | 'neutral',
    output?: { title: string; summary: string; text: string }
  ): Promise<void> {
    const body: any = { status };
    if (conclusion) body.conclusion = conclusion;
    if (output) body.output = output;
    if (status === 'completed') body.completed_at = new Date().toISOString();

    const res = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/check-runs/${checkRunId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Sentinel-App'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      console.error(`Failed to update check run: ${res.status} ${await res.text()}`);
    }
  }

  // Post or Edit PR Comment
  async postPRComment(
    token: string,
    repoOwner: string,
    repoName: string,
    prNumber: number,
    commentBody: string
  ): Promise<void> {
    // 1. Find existing Sentinel comment
    const listRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/issues/${prNumber}/comments`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Sentinel-App'
      }
    });

    let existingCommentId: number | null = null;
    if (listRes.ok) {
      const comments = await listRes.json() as any[];
      const sentinelComment = comments.find(c => c.body && c.body.includes('<!-- sentinel-pr-comment -->'));
      if (sentinelComment) {
        existingCommentId = sentinelComment.id;
      }
    }

    if (existingCommentId) {
      // Update existing comment
      const updateRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/issues/comments/${existingCommentId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'Sentinel-App'
        },
        body: JSON.stringify({ body: commentBody })
      });
      if (!updateRes.ok) {
        console.error(`Failed to update comment: ${updateRes.status}`);
      }
    } else {
      // Create new comment
      const createRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/issues/${prNumber}/comments`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'Sentinel-App'
        },
        body: JSON.stringify({ body: commentBody })
      });
      if (!createRes.ok) {
        console.error(`Failed to create comment: ${createRes.status}`);
      }
    }
  }

  // Create GitHub Issue for Critical Risks
  async createIssue(
    token: string,
    repoOwner: string,
    repoName: string,
    prNumber: number,
    risk: Risk
  ): Promise<void> {
    const bodyText = `### Critical Risk Detected in PR #${prNumber}
    
**Risk Title:** ${risk.title}
**Location:** \`${risk.location}\`
**Pattern ID:** \`${risk.id}\`

**Why:**
${risk.why}

---
*This issue was automatically created by Sentinel due to a critical security/reliability risk detection.*`;

    const res = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Sentinel-App'
      },
      body: JSON.stringify({
        title: `[Sentinel Alert] Critical Risk: ${risk.title}`,
        body: bodyText,
        labels: ['sentinel-alert', 'critical']
      })
    });

    if (!res.ok) {
      console.error(`Failed to automatically create issue: ${res.status} ${await res.text()}`);
    }
  }

  // Get installation ID for a specific repository
  async getRepositoryInstallation(owner: string, repo: string): Promise<number> {
    const appJwt = await this.getAppJwt();
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
      headers: {
        'Authorization': `Bearer ${appJwt}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Sentinel-App'
      }
    });

    if (!res.ok) {
      throw new Error(`Failed to get repo installation: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as any;
    return data.id;
  }

  // Fetch repository basic details (e.g. default branch)
  async getRepositoryDetails(token: string, owner: string, repo: string): Promise<any> {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Sentinel-App'
      }
    });

    if (!res.ok) {
      throw new Error(`Failed to get repo details: ${res.status}`);
    }

    return await res.json();
  }
  // Fetch past pull requests
  async getPastPullRequests(token: string, owner: string, repo: string, limit = 5): Promise<any[]> {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=all&per_page=${limit}`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Sentinel-App'
      }
    });

    if (!res.ok) {
      throw new Error(`Failed to get past PRs: ${res.status}`);
    }

    return await res.json() as any[];
  }

  // Fetch recent commits of a repository
  async getRecentCommits(token: string, owner: string, repo: string, limit = 5): Promise<any[]> {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=${limit}`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Sentinel-App'
      }
    });

    if (!res.ok) {
      throw new Error(`Failed to get recent commits: ${res.status}`);
    }

    return await res.json() as any[];
  }

  // Create GitHub Issue for the Baseline Report
  async createBaselineReportIssue(
    token: string,
    repoOwner: string,
    repoName: string,
    score: number,
    hits: RuleHit[],
    risks: Risk[],
    summary: string
  ): Promise<void> {
    const penaltyLines = hits.map(h => `- **[${h.dimension}]** ${h.title} (-${h.penalty}): ${h.description}`).join('\n') || '_None_';
    const riskLines = risks.map(r => `- **[${r.severity}] ${r.title}** in \`${r.location}\` (\`pattern:${r.id}\`)\n  *Why:* ${r.why}`).join('\n') || '_None_';

    const bodyText = `# 🛡️ Sentinel Baseline Posture Report

Sentinel has completed the initial scan and established a posture baseline for this repository.

### **Baseline Score:** **${score}/100**

---

### 📊 Verifiable Penalties (Deterministic Rule Hits)
These are binary, verifiable checks of engineering health:
${penaltyLines}

---

### 🔍 Predicted Risks & Failure Predictions
These are code-level predictions and inferences from Sentinel's reasoning engine:
${riskLines}

---

### 📝 Summary
${summary}

---
*Sentinel audits what can be verified and predicts what cannot.*`;

    // Check if a baseline report issue already exists to avoid duplicates
    const listRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/issues?labels=sentinel-baseline&state=all`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Sentinel-App'
      }
    });
    if (listRes.ok) {
      const issues = await listRes.json() as any[];
      if (issues.length > 0) {
        console.log('Sentinel baseline issue already exists, skipping issue creation.');
        return;
      }
    }

    const res = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Sentinel-App'
      },
      body: JSON.stringify({
        title: `🛡️ [Sentinel] Baseline Posture Report`,
        body: bodyText,
        labels: ['sentinel-baseline', 'sentinel-report']
      })
    });

    if (!res.ok) {
      console.error(`Failed to create baseline issue: ${res.status} ${await res.text()}`);
    }
  }
}
// Generates the pattern match Markdown section
export function buildPatternMatchSection(
  matchedHistory: Array<{ hit: PatternMatchHit; memories: PatternMemory[] }>
): string {
  if (!matchedHistory.length) return '';
  const blocks = matchedHistory.map(({ hit, memories }) => {
    const memoryBlocks = memories.map(m => `> ${m.content.replace(/\n/g, '\n> ')}`).join('\n');
    return `**${hit.title}** in this PR matches a stored pattern (\`${hit.id}\`):\n${memoryBlocks}`;
  });
  return `### 🧠 Pattern Match\n\n${blocks.join('\n\n')}\n\n---\n`;
}

// Builds the entire pull request audit comment Markdown
export function buildPRComment(
  prNumber: number,
  overallScore: number,
  dimensions: Record<string, number>,
  penaltiesByDimension: Record<string, RuleHit[]>,
  risks: Risk[],
  patternMatchSection: string,
  summary: string,
  predictedFailurePoint?: string,
  predictedFailureWhy?: string,
  predictedFailureImpact?: string,
  predictedFailureConfidence?: number,
  recommendedFixes?: string[],
  deploymentHealthScore?: number | null,
  combinedScore?: number | null
): string {
  const finalScore = combinedScore !== undefined && combinedScore !== null ? combinedScore : overallScore;
  const statusEmoji = finalScore >= 85 ? '✅' : finalScore >= 70 ? '⚠️' : '🚨';
  const riskLevel = finalScore >= 85 ? 'HEALTHY' : finalScore >= 70 ? 'WARNING' : 'CRITICAL';

  // Build dimension table lines (Verify layer)
  const dims = ['security', 'reliability', 'observability', 'performance', 'deployment'];
  const tableLines = dims.map(d => {
    const score = dimensions[d] !== undefined ? dimensions[d] : 100;
    const hits = penaltiesByDimension[d] || [];
    const name = d.charAt(0).toUpperCase() + d.slice(1);
    
    let notes = '-';
    if (hits.length > 0) {
      notes = `capped by: ` + hits.map(h => `${h.id} (-${h.penalty})`).join(', ');
    }
    return `| **${name}** | ${score}/100 | ${notes} |`;
  }).join('\n');

  // Build predictions section
  let predictSection = '';
  if (predictedFailurePoint) {
    predictSection = `### 🔮 Predict — Likely Failure Point
**${predictedFailurePoint}**

**Why:**
${predictedFailureWhy || 'No explanation provided.'}

**Estimated Impact:**
${predictedFailureImpact || 'No impact details provided.'}

**Confidence:** ${predictedFailureConfidence ?? 50}%

---`;
  } else {
    // Fallback if LLM failed
    predictSection = `### 🔮 Predict — Likely Failure Point
_No critical failure predictions generated by reasoning engine._

---`;
  }

  // Build recommended actions section
  let fixesSection = '';
  if (recommendedFixes && recommendedFixes.length > 0) {
    const fixesList = recommendedFixes.map((f, i) => `${i + 1}. ${f}`).join('\n');
    fixesSection = `### 🛠️ Recommended Fixes
${fixesList}`;
  } else {
    // Generate recommended fixes from rule hits
    const flatHits = Object.values(penaltiesByDimension).flat();
    if (flatHits.length > 0) {
      const fixesList = flatHits.map((h, i) => `${i + 1}. ${h.title}: ${h.description}`).join('\n');
      fixesSection = `### 🛠️ Recommended Fixes
${fixesList}`;
    } else {
      fixesSection = `### 🛠️ Recommended Fixes
_No immediate recommended action items verified._`;
    }
  }

  const vercelSection = deploymentHealthScore !== undefined && deploymentHealthScore !== null
    ? `**Vercel Deployment Health Score:** ${deploymentHealthScore}/100\n`
    : '';

  return `<!-- sentinel-pr-comment -->
# ${statusEmoji} Sentinel Risk Prediction: PR #${prNumber} is ${riskLevel} (${finalScore}/100)

${summary}

${vercelSection}
---

${predictSection}

### 📊 Verify — Deterministic Posture Scores

| Dimension | Score | Capping Notes |
| :--- | :--- | :--- |
${tableLines}

---

${patternMatchSection}

${fixesSection}

---
*Sentinel audits what can be verified and predicts what cannot.*
`;
}
