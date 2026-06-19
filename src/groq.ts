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
}

export class GroqEngine {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'llama-3.3-70b-versatile') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async analyzePR(
    repoName: string,
    prNumber: number,
    prTitle: string,
    diff: string,
    files: Record<string, string>,
    memories: any[]
  ): Promise<AnalysisResult> {
    if (!this.apiKey) {
      throw new Error('GROQ_API_KEY is not defined');
    }

    const formattedMemories = memories.length > 0 
      ? memories.map((m, i) => `${i + 1}. [Pattern: ${m.metadata?.pattern || 'unknown'}] Content: ${m.content}`).join('\n')
      : 'No previous incidents or pattern matches stored in memory for this repo.';

    const fileList = Object.keys(files).join(', ');
    const fileContents = Object.entries(files)
      .map(([name, content]) => `--- File: ${name} ---\n${content}`)
      .join('\n\n');

    const systemPrompt = `You are Sentinel's Groq Analysis Engine. Your job is to analyze the PR diff, priority files, and historical pattern memories.
Assess the quality of the PR across 5 dimensions on a 0-100 scale:
1. security: code vulnerabilities, dependency issues, secret leaks, raw environment reads.
2. reliability: error handling, rate limiting, retries, race conditions.
3. observability: logging completeness, metrics, health route status.
4. performance: memory leaks, database query performance, high-latency blocks.
5. deployment: config management, CI/CD compatibility, env verification.

Additionally, identify specific risks added/changed in this PR, especially noting if they match any of the past incidents or pattern memories provided.

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
  "summary": "1-2 sentence high-level summary of the analysis findings"
}

Make sure to rate raw process.env reads lower on 'deployment' and 'security' if no validation library is present.
Make sure to search for unwrapped await calls and penalize 'reliability' accordingly.
If a risk matches a past incident's pattern ID, reuse that exact pattern ID in your "id" field so the memory matches!

Provide ONLY the raw JSON output. No conversational wrapper, no markdown block formatting.`;

    const userPrompt = `Repository: ${repoName}
PR #${prNumber}: "${prTitle}"

=== PR DIFF ===
${diff}

=== RELEVANT SOURCE FILES ===
Files included: ${fileList}
${fileContents}

=== HISTORICAL INCIDENT MEMORIES ===
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
      // Return a safe fallback schema instead of throwing, ensuring Sentinel is resilient
      return {
        dimensions: { security: 80, reliability: 80, observability: 80, performance: 80, deployment: 80 },
        risks: [
          {
            id: 'groq-analysis-failure',
            title: 'Groq analysis execution failed',
            location: 'global',
            why: err instanceof Error ? err.message : String(err),
            severity: 'warning'
          }
        ],
        summary: 'Groq analysis was bypassed due to API error. Local deterministic checks still apply.'
      };
    }
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
        summary: String(parsed.summary || 'PR analysis completed.')
      };
    } catch (err) {
      console.error('Failed to parse Groq response JSON:', err, '\nRaw Text:', text);
      throw new Error(`Invalid JSON format from Groq: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
