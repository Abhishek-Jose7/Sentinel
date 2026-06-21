// src/parcle.ts

export interface Memory {
  id: string;
  content: string;
  tags?: string[];
  metadata?: any;
}

export interface PatternMemory extends Memory {
  metadata?: {
    tags: string[];
    pattern?: string;       // structured pattern ID, e.g. 'no-rate-limit'
    repo?: string;
    prNumber?: number;
    resolved?: boolean;
    source: 'Sentinel';
    ts: number;
  };
}

export class ParcleClient {
  private apiKey: string | null;
  private db: any; // D1Database
  private static registeredUsers = new Set<string>();

  constructor(apiKey: string | null, db: any) {
    this.apiKey = apiKey || null;
    this.db = db;
  }

  async store(content: string, tags: string[], metadata?: any): Promise<void> {
    if (this.apiKey) {
      try {
        const repo = metadata?.repo || (tags && tags[1]) || 'sentinel-default';
        const userId = repo.split('/')[0] || 'sentinel_user';
        const pattern = metadata?.pattern || tags[0] || 'unknown';
        const prNumber = metadata?.prNumber || 0;
        const resolved = metadata?.resolved ? true : false;

        // Register user first (cached in this worker container instance)
        if (!ParcleClient.registeredUsers.has(userId)) {
          const regRes = await fetch('https://api.parcle.ai/v1/users', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              user_id: userId,
              name: userId
            })
          });
          if (regRes.ok) {
            ParcleClient.registeredUsers.add(userId);
          }
        }

        const res = await fetch('https://api.parcle.ai/v1/memories/ingest_dialog', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            user_id: userId,
            messages: [
              {
                role: 'user',
                content: content
              }
            ],
            tag: {
              repo,
              pattern,
              prNumber,
              resolved
            }
          })
        });
        if (!res.ok) {
          console.error(`Parcle store API error: ${res.status} ${await res.text()}`);
          await this.storeLocal(content, tags, metadata);
        }
      } catch (err) {
        console.error('Parcle store connection error, falling back to D1:', err);
        await this.storeLocal(content, tags, metadata);
      }
    } else {
      await this.storeLocal(content, tags, metadata);
    }
  }

  async recall(query: string, limit = 4): Promise<PatternMemory[]> {
    if (this.apiKey) {
      try {
        const repoMatch = query.match(/repo:(\S+)/);
        const repo = repoMatch ? repoMatch[1] : 'sentinel-default';
        const userId = repo.split('/')[0] || 'sentinel_user';

        const tagFilter: any = { repo };
        const patternMatch = query.match(/pattern:(\S+)/);
        if (patternMatch) {
          tagFilter.pattern = patternMatch[1];
        }

        const res = await fetch('https://api.parcle.ai/v1/memories/sources', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            user_id: userId,
            tag_filter: tagFilter,
            limit: limit
          })
        });

        if (!res.ok) {
          console.error(`Parcle search API error: ${res.status} ${await res.text()}`);
          return this.recallLocal(query, limit);
        }

        const data = await res.json() as any;
        const sources = (data.sources || []).slice(0, limit);
        const memories: PatternMemory[] = [];

        for (const source of sources) {
          if (source.type === 'session') {
            try {
              const sessRes = await fetch('https://api.parcle.ai/v1/memories/sessions', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${this.apiKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  user_id: userId,
                  session_id: source.id
                })
              });
              if (sessRes.ok) {
                const sessData = await sessRes.json() as any;
                const messages = sessData.messages || [];
                const content = messages
                  .filter((m: any) => m.role === 'user')
                  .map((m: any) => m.content)
                  .join('\n');

                memories.push({
                  id: source.id,
                  content: content,
                  tags: source.tag ? [source.tag.pattern, source.tag.repo] : [],
                  metadata: {
                    tags: source.tag ? [source.tag.pattern, source.tag.repo] : [],
                    pattern: source.tag?.pattern || 'unknown',
                    repo: source.tag?.repo || 'unknown',
                    prNumber: source.tag?.prNumber || 0,
                    resolved: !!source.tag?.resolved,
                    source: 'Sentinel',
                    ts: source.updated_at ? new Date(source.updated_at).getTime() : Date.now()
                  }
                });
              }
            } catch (err) {
              console.error(`Error fetching Parcle session details for ${source.id}:`, err);
            }
          }
        }

        return memories;
      } catch (err) {
        console.error('Parcle search connection error, falling back to D1:', err);
        return this.recallLocal(query, limit);
      }
    } else {
      return this.recallLocal(query, limit);
    }
  }

  private async storeLocal(content: string, tags: string[], metadata?: any): Promise<void> {
    if (!this.db) {
      console.warn('No D1 Database bound. Cannot store memory locally.');
      return;
    }
    const pattern = metadata?.pattern || tags[0] || 'unknown';
    const repo = metadata?.repo || tags[1] || 'unknown';
    const prNumber = metadata?.prNumber || 0;
    const resolved = metadata?.resolved ? 1 : 0;
    const id = crypto.randomUUID();

    try {
      await this.db.prepare(
        `INSERT INTO local_memories (id, content, pattern_id, repo_name, pr_number, tags, resolved) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        content,
        pattern,
        repo,
        prNumber,
        JSON.stringify(tags),
        resolved
      ).run();
    } catch (err) {
      console.error('Error inserting local memory:', err);
    }
  }

  private async recallLocal(query: string, limit = 4): Promise<PatternMemory[]> {
    if (!this.db) {
      console.warn('No D1 Database bound. Cannot recall memory locally.');
      return [];
    }

    let patternQuery = '';
    let repoQuery = '';

    const patternMatch = query.match(/pattern:(\S+)/);
    if (patternMatch) patternQuery = patternMatch[1];

    const repoMatch = query.match(/repo:(\S+)/);
    if (repoMatch) repoQuery = repoMatch[1];

    try {
      let results: any;
      if (patternQuery && repoQuery) {
        results = await this.db.prepare(
          `SELECT * FROM local_memories 
           WHERE pattern_id = ? AND repo_name = ? 
           ORDER BY created_at DESC LIMIT ?`
        ).bind(patternQuery, repoQuery, limit).all();
      } else if (patternQuery) {
        results = await this.db.prepare(
          `SELECT * FROM local_memories 
           WHERE pattern_id = ? 
           ORDER BY created_at DESC LIMIT ?`
        ).bind(patternQuery, limit).all();
      } else {
        const cleanQuery = `%${query}%`;
        results = await this.db.prepare(
          `SELECT * FROM local_memories 
           WHERE content LIKE ? OR pattern_id LIKE ? 
           ORDER BY created_at DESC LIMIT ?`
        ).bind(cleanQuery, cleanQuery, limit).all();
      }

      const rows = results.results || [];
      return rows.map((r: any) => ({
        id: r.id,
        content: r.content,
        tags: JSON.parse(r.tags),
        metadata: {
          tags: JSON.parse(r.tags),
          pattern: r.pattern_id,
          repo: r.repo_name,
          prNumber: r.pr_number,
          resolved: !!r.resolved,
          source: 'Sentinel',
          ts: new Date(r.created_at + 'Z').getTime() // parse as UTC
        }
      }));
    } catch (err) {
      console.error('Error recalling local memories:', err);
      return [];
    }
  }

  async storePattern(
    content: string,
    pattern: string,
    repo: string,
    extra: { tags?: string[]; prNumber?: number; resolved?: boolean } = {}
  ): Promise<void> {
    const tags = [pattern, repo, ...(extra.tags ?? [])];
    const metadata = {
      tags,
      pattern,
      repo,
      prNumber: extra.prNumber,
      resolved: extra.resolved,
      source: 'Sentinel' as const,
      ts: Date.now()
    };
    await this.store(content, tags, metadata);
  }

  async recallByPattern(
    pattern: string,
    repo: string,
    limit = 4,
    excludePrNumber?: number
  ): Promise<PatternMemory[]> {
    const memories = await this.recall(`pattern:${pattern} repo:${repo}`, limit);
    if (excludePrNumber === undefined) {
      return memories;
    }
    return memories.filter(memory => Number(memory.metadata?.prNumber) !== excludePrNumber);
  }

  async recallByRepo(repo: string, limit = 50): Promise<PatternMemory[]> {
    if (this.apiKey) {
      try {
        const userId = repo.split('/')[0] || 'sentinel_user';
        const res = await fetch('https://api.parcle.ai/v1/memories/sources', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            user_id: userId,
            tag_filter: { repo },
            limit
          })
        });
        if (!res.ok) {
          console.error(`Parcle recallByRepo API error: ${res.status} ${await res.text()}`);
          return this.recallLocalByRepo(repo, limit);
        }
        const data = await res.json() as any;
        const sources = (data.sources || []).slice(0, limit);
        const memories: PatternMemory[] = [];

        for (const source of sources) {
          if (source.type === 'session') {
            try {
              const sessRes = await fetch('https://api.parcle.ai/v1/memories/sessions', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${this.apiKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  user_id: userId,
                  session_id: source.id
                })
              });
              if (sessRes.ok) {
                const sessData = await sessRes.json() as any;
                const messages = sessData.messages || [];
                const content = messages
                  .filter((m: any) => m.role === 'user')
                  .map((m: any) => m.content)
                  .join('\n');

                memories.push({
                  id: source.id,
                  content: content,
                  tags: source.tag ? [source.tag.pattern, source.tag.repo] : [],
                  metadata: {
                    tags: source.tag ? [source.tag.pattern, source.tag.repo] : [],
                    pattern: source.tag?.pattern || 'unknown',
                    repo: source.tag?.repo || 'unknown',
                    prNumber: source.tag?.prNumber || 0,
                    resolved: !!source.tag?.resolved,
                    source: 'Sentinel',
                    ts: source.updated_at ? new Date(source.updated_at).getTime() : Date.now()
                  }
                });
              }
            } catch (err) {
              console.error(`Error fetching Parcle session in recallByRepo ${source.id}:`, err);
            }
          }
        }
        return memories;
      } catch (err) {
        console.error('Parcle search connection error in recallByRepo, falling back to D1:', err);
        return this.recallLocalByRepo(repo, limit);
      }
    } else {
      return this.recallLocalByRepo(repo, limit);
    }
  }

  private async recallLocalByRepo(repo: string, limit = 50): Promise<PatternMemory[]> {
    if (!this.db) return [];
    try {
      const results = await this.db.prepare(
        `SELECT * FROM local_memories 
         WHERE repo_name = ? 
         ORDER BY created_at DESC LIMIT ?`
      ).bind(repo, limit).all();
      const rows = results.results || [];
      return rows.map((r: any) => ({
        id: r.id,
        content: r.content,
        tags: JSON.parse(r.tags),
        metadata: {
          tags: JSON.parse(r.tags),
          pattern: r.pattern_id,
          repo: r.repo_name,
          prNumber: r.pr_number,
          resolved: !!r.resolved,
          source: 'Sentinel',
          ts: new Date(r.created_at + 'Z').getTime()
        }
      }));
    } catch (err) {
      console.error('Error recalling local memories by repo:', err);
      return [];
    }
  }
}
