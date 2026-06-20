// src/groq.ts

import { VercelMetrics } from './vercel';

export interface Risk {
  id: string; // kebab-case pattern ID, e.g. 'missing-retry-on-external-call'
  title: string;
  location: string; // file path and optionally lines, e.g. 'src/checkout.ts#L45'
  why: string;
  severity: 'critical' | 'warning' | 'info';
}

export interface AnalysisResult {
  dimensions: {
    security: number;
    reliability: number;
    observability: number;
    performance: number;
    deployment: number;
  };
  risks: Risk[];
  summary: string;
  thought_process: string;
  predicted_failure_point?: string;
  predicted_failure_why?: string;
  predicted_failure_impact?: string;
  predicted_failure_confidence?: number;
  recommended_fixes?: string[];
}

export interface BaselineAnalysisInput {
  repoName: string;
  branch: string;
  facts: any;
  dimensions: Record<string, number>;
  hits: Array<{ id: string; dimension: string; penalty: number; title: string; description: string }>;
  memories: any[];
  deploymentMetrics?: VercelMetrics;
}

export class GroqEngine {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'llama3-8b-8192') {
    this.apiKey = apiKey;
    this.model = model;
  }

  private getChangedFilesFromDiff(diff: string): string[] {
    const files = new Set<string>();
    const lines = diff.split('\n');
    for (const line of lines) {
      if (line.startsWith('+++ b/')) {
        const file = line.substring(6).trim();
        if (file) files.add(file);
      }
    }
    return Array.from(files);
  }

  private formatFactsForPrompt(facts: any): string {
    if (!facts) return 'No repository facts available.';
    return [
      `Scanned Files: ${facts.scannedFileCount || 0}`,
      `Architecture: ${(facts.architecture || []).join(', ') || 'Unknown'}`,
      `Rate Limiting: ${facts.hasRateLimiting ? 'Present' : 'Absent'}`,
      `Health Endpoint: ${facts.hasHealthEndpoint ? 'Present' : 'Absent'}`,
      `Structured Logging: ${facts.hasStructuredLogging ? 'Present' : 'Absent'}`,
      `Env Variable Validation: ${facts.hasEnvValidation ? 'Present' : 'Absent'}`,
      `Test Suite: ${facts.hasTests ? 'Detected' : 'Not detected'}`,
      `Monitoring & Tracing: ${facts.hasMonitoring ? 'Present' : 'Absent'}`,
      `Continuous Integration (CI): ${facts.hasCiConfig ? 'Present' : 'Absent'}`,
      `Containerization (Dockerfile): ${facts.hasDockerfile ? 'Present' : 'Absent'}`,
      `Uses Database: ${facts.usesDatabase ? 'Yes' : 'No'}`,
      `Uses Authentication: ${facts.usesAuthentication ? 'Yes' : 'No'}`,
      `Environment Variable Reads: ${(facts.envReads || []).join(', ') || 'None'}`
    ].join('\n');
  }

  private formatDeploymentMetricsForPrompt(metrics?: VercelMetrics): string {
    if (!metrics) return 'No Vercel deployment metrics connected for this repository.';
    return [
      `Vercel Project Status: Connected`,
      `Last Deployment Status: ${metrics.last_status}`,
      `Success Rate: ${Math.round(metrics.success_rate * 100)}%`,
      `Failed Deployment Count (30d): ${metrics.failed_count}`,
      `Deployments in Last 7 Days: ${metrics.deploys_7d}`,
      `Deployments in Last 30 Days: ${metrics.deploys_30d}`
    ].join('\n');
  }

  async analyzePR(
    repoName: string,
    prNumber: number,
    prTitle: string,
    diff: string,
    facts: any,
    hits: Array<{ id: string; dimension: string; penalty: number; title: string; description: string }>,
    memories: any[],
    deploymentMetrics?: VercelMetrics
  ): Promise<AnalysisResult> {
    if (!this.apiKey) {
      throw new Error('GROQ_API_KEY is not defined');
    }

    const changedFiles = this.getChangedFilesFromDiff(diff);
    const formattedMemories = memories.length > 0 
      ? memories.slice(0, 3).map((m, i) => `${i + 1}. [Pattern: ${m.metadata?.pattern || 'unknown'}] Content: ${m.content}`).join('\n')
      : 'No previous incidents or pattern matches stored in memory for this repo.';

    const systemPrompt = `You are Sentinel's Groq Prediction Engine. Your job is to analyze a PR based on:
1. The list of changed files.
2. The PR diff (representing just the change).
3. The repository configuration facts.
4. Historical pattern memories.
5. Vercel deployment success/failure metrics (if connected).

Reposition Sentinel's analysis from a mere static linter to an executive risk prediction system.
- The Verify layer establishes facts (rate limiting, health endpoints, env validation, logs).
- The Predict layer explains what is likely to break and why, and estimates impact.
- The Recall layer connects findings to past incidents.

Assess the quality across 5 dimensions (0-100 scale): security, reliability, observability, performance, deployment.

Identify specific risks added/changed in this PR.
Generate an executive prediction of engineering risk:
1. "predicted_failure_point": Most likely failure point (e.g. "Authentication service becomes unstable under traffic spikes").
2. "predicted_failure_why": Explain why Sentinel believes this, linking it to the facts (e.g. no rate limiting found, etc.), deployment metrics (e.g., failed builds), and recalled patterns.
3. "predicted_failure_impact": Estimated operational or business impact.
4. "predicted_failure_confidence": An integer confidence percentage (0-100) representing how certain we are this failure is possible.
5. "recommended_fixes": Array of specific, actionable fix recommendations (e.g., ["Add rate limiting", "Add health endpoint", "Implement structured logging"]).

You must output a single, strictly valid JSON object matching the following TypeScript schema:
{
  "dimensions": {
    "security": number,
    "reliability": number,
    "observability": number,
    "performance": number,
    "deployment": number
  },
  "risks": [
    {
      "id": "kebab-case-pattern-id-string",
      "title": "short description of risk",
      "location": "file_path.ts#Lline_number",
      "why": "explanation of what could go wrong",
      "severity": "critical" | "warning" | "info"
    }
  ],
  "summary": "1-2 sentence high-level summary of the findings",
  "thought_process": "detailed string explaining the LLM's step-by-step reasoning",
  "predicted_failure_point": "string",
  "predicted_failure_why": "string",
  "predicted_failure_impact": "string",
  "predicted_failure_confidence": number,
  "recommended_fixes": ["string"]
}

Provide ONLY the raw JSON output. No conversational wrapper, no markdown block formatting.`;

    const userPrompt = `Repository: ${repoName}
PR #${prNumber}: "${prTitle}"

Changed Files:
${changedFiles.map(f => `- ${f}`).join('\n')}

Repository Facts & Architecture:
${this.formatFactsForPrompt(facts)}

Vercel Deployment Metrics:
${this.formatDeploymentMetricsForPrompt(deploymentMetrics)}

Deterministic Rule Hits in this PR:
${JSON.stringify(hits, null, 2)}

=== PR DIFF (THE CHANGE) ===
${this.compactText(diff, 4000)}

=== TOP HISTORICAL INCIDENT MEMORIES ===
${formattedMemories}

Analyze the changes and output your JSON:`;

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1
        })
      });

      if (!response.ok) {
        throw new Error(`Groq API returned status ${response.status}: ${await response.text()}`);
      }

      const responseData = await response.json() as any;
      const jsonText = responseData.choices?.[0]?.message?.content || '';
      
      return this.parseJSONContent(jsonText);
    } catch (err) {
      console.error('Groq analysis query failed:', err);
      // Calculate deterministic fallback
      const fallbackDims = { security: 100, reliability: 100, observability: 100, performance: 100, deployment: 100 };
      for (const hit of hits) {
        const dim = hit.dimension as keyof typeof fallbackDims;
        if (fallbackDims[dim] !== undefined) {
          fallbackDims[dim] = Math.max(0, fallbackDims[dim] - hit.penalty);
        }
      }
      return {
        dimensions: fallbackDims,
        risks: [
          {
            id: 'groq-analysis-failure',
            title: 'Groq analysis execution failed',
            location: 'global',
            why: err instanceof Error ? err.message : String(err),
            severity: 'warning'
          }
        ],
        summary: 'Groq analysis was bypassed due to API error. Local deterministic checks still apply.',
        thought_process: `Groq LLM reasoning execution encountered an error: ${err instanceof Error ? err.message : String(err)}. Falling back to deterministic rules calculation.`,
        predicted_failure_point: 'Unresolved deployment or repository scanning vulnerability.',
        predicted_failure_why: 'LLM reasoning engine was unreachable. Static rules indicated potential vulnerabilities.',
        predicted_failure_impact: 'High availability is at risk due to lack of verify compliance checks.',
        predicted_failure_confidence: 50,
        recommended_fixes: hits.map(h => `Add ${h.id.replace('no-', '')}`)
      };
    }
  }

  async analyzeBaseline(input: BaselineAnalysisInput): Promise<AnalysisResult> {
    if (!this.apiKey) {
      throw new Error('GROQ_API_KEY is not defined');
    }

    const memories = input.memories.length > 0
      ? input.memories.slice(0, 3).map((m, i) => `${i + 1}. [Pattern: ${m.metadata?.pattern || 'unknown'}] ${this.compactText(m.content || '', 600)}`).join('\n')
      : 'No matching repository memories found.';

    const systemPrompt = `You are Sentinel's baseline prediction engine.
You receive compact repository facts, Vercel deployment metrics, and memories.
Reposition Sentinel's output from lint warnings to executive risk predictions:
- The Verify layer establishes facts.
- The Predict layer explains what is likely to break and why.
- The Recall layer connects findings to past incidents.

Generate a concise JSON-only baseline analysis. Ground failure predictions in the facts, deployment metrics, and rule hits provided.

Generate the executive prediction layer fields:
1. "predicted_failure_point": Most likely failure point
2. "predicted_failure_why": Explain why Sentinel believes this, referencing lack of verify facts or deployment indicators.
3. "predicted_failure_impact": Business or operational impact
4. "predicted_failure_confidence": An integer confidence percentage (0-100)
5. "recommended_fixes": Array of recommended actions ordered by priority.

Return JSON matching this schema:
{
  "dimensions": {
    "security": number,
    "reliability": number,
    "observability": number,
    "performance": number,
    "deployment": number
  },
  "risks": [
    {
      "id": "kebab-case-pattern-id",
      "title": "short failure prediction or recommendation",
      "location": "repository|config|api|tests|observability",
      "why": "plain explanation grounded in facts",
      "severity": "critical" | "warning" | "info"
    }
  ],
  "summary": "1-2 sentence baseline readiness summary",
  "thought_process": "detailed string explaining the LLM's thought process",
  "predicted_failure_point": "string",
  "predicted_failure_why": "string",
  "predicted_failure_impact": "string",
  "predicted_failure_confidence": number,
  "recommended_fixes": ["string"]
}

Keep dimensions close to the deterministic scores.`;

    const userPrompt = `Repository: ${input.repoName}
Branch: ${input.branch}

Repository Facts:
${this.formatFactsForPrompt(input.facts)}

Vercel Deployment Metrics:
${this.formatDeploymentMetricsForPrompt(input.deploymentMetrics)}

Deterministic Dimension Scores:
${JSON.stringify(input.dimensions, null, 2)}

Rule Hits:
${JSON.stringify(input.hits, null, 2)}

Top Memories:
${memories}

Return JSON matching this schema:`;

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1
        })
      });

      if (!response.ok) {
        throw new Error(`Groq API returned status ${response.status}: ${await response.text()}`);
      }

      const responseData = await response.json() as any;
      return this.parseJSONContent(responseData.choices?.[0]?.message?.content || '');
    } catch (err) {
      console.error('Groq baseline analysis query failed:', err);
      return {
        dimensions: {
          security: input.dimensions.security ?? 100,
          reliability: input.dimensions.reliability ?? 100,
          observability: input.dimensions.observability ?? 100,
          performance: input.dimensions.performance ?? 100,
          deployment: input.dimensions.deployment ?? 100
        },
        risks: input.hits.map(hit => ({
          id: hit.id,
          title: hit.title,
          location: hit.dimension,
          why: hit.description,
          severity: hit.penalty >= 15 ? 'warning' : 'info'
        })),
        summary: 'Baseline analysis used deterministic repository facts because Groq reasoning was unavailable.',
        thought_process: `Baseline Groq analysis query failed: ${err instanceof Error ? err.message : String(err)}. Substituted default deterministic fact models.`,
        predicted_failure_point: 'Engineering reliability and security gaps detected.',
        predicted_failure_why: 'Local checks flag several missing posture indicators.',
        predicted_failure_impact: 'Lack of rate limiting and logging puts application availability at risk.',
        predicted_failure_confidence: 60,
        recommended_fixes: input.hits.map(h => `Add ${h.id.replace('no-', '')}`)
      };
    }
  }

  private compactText(text: string, maxChars: number): string {
    if (!text || text.length <= maxChars) return text || '';
    const head = text.slice(0, Math.floor(maxChars * 0.65));
    const tail = text.slice(text.length - Math.floor(maxChars * 0.25));
    return `${head}\n\n...[trimmed ${text.length - head.length - tail.length} chars]...\n\n${tail}`;
  }

  private parseJSONContent(text: string): AnalysisResult {
    let cleanText = text.trim();
    // Strip markdown code fences if present
    if (cleanText.startsWith('```')) {
      const lines = cleanText.split('\n');
      if (lines[0].includes('json')) {
        lines.shift();
      } else {
        lines.shift();
      }
      if (lines[lines.length - 1].startsWith('```')) {
        lines.pop();
      }
      cleanText = lines.join('\n').trim();
    }

    try {
      const parsed = JSON.parse(cleanText);
      
      const rawDims = parsed.dimensions ?? parsed.Dimensions ?? parsed.DIMENSIONS ?? {};
      const risksList = parsed.risks ?? parsed.Risks ?? parsed.RISKS ?? [];

      const getNumericScore = (val: any, fallback = 100): number => {
        if (typeof val === 'number') return val;
        if (typeof val === 'string') {
          const parsedVal = parseInt(val, 10);
          return isNaN(parsedVal) ? fallback : parsedVal;
        }
        return fallback;
      };

      const security = rawDims.security ?? rawDims.Security ?? rawDims.SECURITY;
      const reliability = rawDims.reliability ?? rawDims.Reliability ?? rawDims.RELIABILITY;
      const observability = rawDims.observability ?? rawDims.Observability ?? rawDims.OBSERVABILITY;
      const performance = rawDims.performance ?? rawDims.Performance ?? rawDims.PERFORMANCE;
      const deployment = rawDims.deployment ?? rawDims.Deployment ?? rawDims.DEPLOYMENT;

      return {
        dimensions: {
          security: getNumericScore(security, 100),
          reliability: getNumericScore(reliability, 100),
          observability: getNumericScore(observability, 100),
          performance: getNumericScore(performance, 100),
          deployment: getNumericScore(deployment, 100)
        },
        risks: Array.isArray(risksList) ? risksList.map((r: any) => ({
          id: String(r.id ?? r.Id ?? r.ID ?? 'unknown-pattern'),
          title: String(r.title ?? r.Title ?? r.TITLE ?? 'Inferred Risk'),
          location: String(r.location ?? r.Location ?? r.LOCATION ?? 'unknown'),
          why: String(r.why ?? r.Why ?? r.WHY ?? ''),
          severity: ['critical', 'warning', 'info'].includes(String(r.severity ?? '').toLowerCase()) 
            ? (String(r.severity).toLowerCase() as 'critical' | 'warning' | 'info') 
            : 'warning'
        })) : [],
        summary: String(parsed.summary ?? parsed.Summary ?? parsed.SUMMARY ?? 'PR analysis completed.'),
        thought_process: String(parsed.thought_process ?? parsed.thoughtProcess ?? parsed.ThoughtProcess ?? parsed.THOUGHT_PROCESS ?? 'LLM reasoning successfully completed.'),
        predicted_failure_point: parsed.predicted_failure_point || parsed.predictedFailurePoint || undefined,
        predicted_failure_why: parsed.predicted_failure_why || parsed.predictedFailureWhy || undefined,
        predicted_failure_impact: parsed.predicted_failure_impact || parsed.predictedFailureImpact || undefined,
        predicted_failure_confidence: parsed.predicted_failure_confidence !== undefined ? Number(parsed.predicted_failure_confidence) : undefined,
        recommended_fixes: Array.isArray(parsed.recommended_fixes || parsed.recommendedFixes) ? (parsed.recommended_fixes || parsed.recommendedFixes) : undefined
      };
    } catch (err) {
      console.error('Failed to parse Groq response JSON:', err, '\nRaw Text:', text);
      throw new Error(`Invalid JSON format from Groq: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
