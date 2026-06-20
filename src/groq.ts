// src/groq.ts

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
}

export interface BaselineAnalysisInput {
  repoName: string;
  branch: string;
  facts: any;
  dimensions: Record<string, number>;
  hits: Array<{ id: string; dimension: string; penalty: number; title: string; description: string }>;
  memories: any[];
}

export class GroqEngine {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'llama-3.1-8b-instant') {
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

  async analyzePR(
    repoName: string,
    prNumber: number,
    prTitle: string,
    diff: string,
    facts: any,
    hits: Array<{ id: string; dimension: string; penalty: number; title: string; description: string }>,
    memories: any[]
  ): Promise<AnalysisResult> {
    if (!this.apiKey) {
      throw new Error('GROQ_API_KEY is not defined');
    }

    const changedFiles = this.getChangedFilesFromDiff(diff);
    const formattedMemories = memories.length > 0 
      ? memories.slice(0, 3).map((m, i) => `${i + 1}. [Pattern: ${m.metadata?.pattern || 'unknown'}] Content: ${m.content}`).join('\n')
      : 'No previous incidents or pattern matches stored in memory for this repo.';

    const systemPrompt = `You are Sentinel's Groq Analysis Engine. Your job is to analyze a PR based on:
1. The list of changed files.
2. The PR diff (which represents "Just the change", not entire files).
3. The repository configuration facts.
4. Historical pattern memories.

Assess the quality of the PR across 5 dimensions on a 0-100 scale:
1. security: code vulnerabilities, dependency issues, secret leaks, raw environment reads.
2. reliability: error handling, rate limiting, retries, race conditions.
3. observability: logging completeness, metrics, health route status.
4. performance: memory leaks, database query performance, high-latency blocks.
5. deployment: config management, CI/CD compatibility, env verification.

Identify specific risks added/changed in this PR, especially noting if they match any of the past incidents or pattern memories provided.

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
      "why": "explanation of what could go wrong and how it fits patterns",
      "severity": "critical" | "warning" | "info"
    }
  ],
  "summary": "1-2 sentence high-level summary of the analysis findings",
  "thought_process": "detailed string explaining the LLM's thought process, reasoning steps, code quality evaluation, security considerations, and intermediate deductions during analysis of this PR and diff"
}

Ground all risks strictly in the diff or facts provided. Only penalize dimensions if the diff introduces issues, or if the repository facts indicate a lack of features.
Provide ONLY the raw JSON output. No conversational wrapper, no markdown block formatting.`;

    const userPrompt = `Repository: ${repoName}
PR #${prNumber}: "${prTitle}"

Changed Files:
${changedFiles.map(f => `- ${f}`).join('\n')}

Repository Facts & Architecture:
${this.formatFactsForPrompt(facts)}

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
      // Calculate deterministic fallback from hits starting from 100
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
        thought_process: `Groq LLM reasoning execution encountered an error: ${err instanceof Error ? err.message : String(err)}. Falling back to deterministic rules calculation.`
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

    const systemPrompt = `You are Sentinel's baseline analysis engine.
You receive compact repository facts and deterministic scores, not full repository files.
Generate a concise JSON-only baseline analysis. Do not invent file contents. Ground recommendations in the facts and rule hits provided.`;

    const userPrompt = `Repository: ${input.repoName}
Branch: ${input.branch}

Repository Facts:
${this.formatFactsForPrompt(input.facts)}

Deterministic Dimension Scores:
${JSON.stringify(input.dimensions, null, 2)}

Rule Hits:
${JSON.stringify(input.hits, null, 2)}

Top Memories:
${memories}

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
  "thought_process": "detailed string explaining the LLM's thought process, reasoning steps, configuration review, risk calculations, and intermediate deductions during baseline assessment of the codebase"
}

Keep dimensions close to the deterministic scores. Only adjust by at most 5 points per dimension if the facts justify it.`;

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
        thought_process: `Baseline Groq analysis query failed: ${err instanceof Error ? err.message : String(err)}. Substituted default deterministic fact models.`
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
      // Validate schema minimally
      if (!parsed.dimensions || !parsed.risks) {
        throw new Error('Parsed response missing dimensions or risks properties');
      }
      
      const dims = parsed.dimensions;
      return {
        dimensions: {
          security: typeof dims.security === 'number' ? dims.security : 80,
          reliability: typeof dims.reliability === 'number' ? dims.reliability : 80,
          observability: typeof dims.observability === 'number' ? dims.observability : 80,
          performance: typeof dims.performance === 'number' ? dims.performance : 80,
          deployment: typeof dims.deployment === 'number' ? dims.deployment : 80
        },
        risks: Array.isArray(parsed.risks) ? parsed.risks.map((r: any) => ({
          id: String(r.id || 'unknown-pattern'),
          title: String(r.title || 'Inferred Risk'),
          location: String(r.location || 'unknown'),
          why: String(r.why || ''),
          severity: ['critical', 'warning', 'info'].includes(r.severity) ? r.severity : 'warning'
        })) : [],
        summary: String(parsed.summary || 'PR analysis completed.'),
        thought_process: String(parsed.thought_process || 'LLM reasoning successfully completed. Codebase structures and historical patterns mapped against deterministic rule sets.')
      };
    } catch (err) {
      console.error('Failed to parse Groq response JSON:', err, '\nRaw Text:', text);
      throw new Error(`Invalid JSON format from Groq: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
