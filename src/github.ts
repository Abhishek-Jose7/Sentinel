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
    this.privateKey = privateKey;
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
    paths: string[]
  ): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const path of paths) {
      const content = await this.getFileContent(token, repoOwner, repoName, path, ref);
      if (content) {
        files[path] = content;
      }
    }
    return files;
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
  summary: string
): string {
  const statusEmoji = overallScore >= 70 ? '✅' : '⚠️';
  const statusText = overallScore >= 70 ? 'PASS' : 'FAIL';

  // Build dimension table lines
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

  // Build risk breakdown
  const riskLines = risks.length > 0
    ? risks.map(r => {
        const severityBadge = r.severity === 'critical' ? '🔴 critical' : r.severity === 'warning' ? '🟡 warning' : '🔵 info';
        return `- **[${severityBadge}] ${r.title}** in \`${r.location}\` (\`pattern:${r.id}\`)\n  *Why:* ${r.why}`;
      }).join('\n')
    : '_No predicted risks identified by the reasoning engine._';

  return `<!-- sentinel-pr-comment -->
# ${statusEmoji} Sentinel PR Audit: PR #${prNumber} is a **${statusText}** (${overallScore}/100)

${summary}

${patternMatchSection}
### 📊 Dimension Scores

| Dimension | Score | Notes |
| :--- | :--- | :--- |
${tableLines}

---

### 🔍 Predicted Risks & Reasoning
${riskLines}

---
*Sentinel audits what can be verified and predicts what cannot.*
`;
}
