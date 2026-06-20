// src/db.ts

export interface DbRepo {
  id: number;
  owner: string;
  name: string;
  installed_at: string;
  current_score: number | null;
  license_key: string | null;
  is_pro: number; // 0 or 1
  scan_status: string;
  scan_message: string;
}

export interface DbPR {
  id: string;
  repo_id: number;
  pr_number: number;
  title: string;
  state: string;
  overall_score: number;
  security_score: number;
  reliability_score: number;
  observability_score: number;
  performance_score: number;
  deployment_score: number;
  thought_process: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbRuleHit {
  id: string;
  pr_id: string;
  rule_id: string;
  dimension: string;
  penalty: number;
  title: string;
  description: string;
  created_at: string;
}

export interface DbRisk {
  id: string;
  pr_id: string;
  pattern_id: string;
  title: string;
  location: string;
  why: string;
  severity: string;
  created_at: string;
}

export class DbHelper {
  private db: any; // D1Database

  constructor(db: any) {
    this.db = db;
  }

  async getRepo(owner: string, name: string): Promise<DbRepo | null> {
    if (!this.db) return null;
    const res = await this.db.prepare(
      'SELECT * FROM repositories WHERE owner = ? AND name = ?'
    ).bind(owner, name).first();
    return res as DbRepo | null;
  }

  async upsertRepo(id: number, owner: string, name: string): Promise<void> {
    if (!this.db) return;
    await this.db.prepare(
      `INSERT INTO repositories (id, owner, name) 
       VALUES (?, ?, ?) 
       ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, name=excluded.name`
    ).bind(id, owner, name).run();
  }

  async updateRepoScore(id: number, score: number): Promise<void> {
    if (!this.db) return;
    await this.db.prepare(
      'UPDATE repositories SET current_score = ? WHERE id = ?'
    ).bind(score, id).run();
  }

  async updateRepoScanStatus(id: number, status: string, message: string): Promise<void> {
    if (!this.db) return;
    await this.db.prepare(
      'UPDATE repositories SET scan_status = ?, scan_message = ? WHERE id = ?'
    ).bind(status, message, id).run();
  }

  async activatePro(owner: string, name: string, licenseKey: string): Promise<boolean> {
    if (!this.db) return false;
    // Basic format validation for Sentinel Pro: e.g. "SENTINEL-PRO-..."
    if (!licenseKey.startsWith('SENTINEL-PRO-') || licenseKey.length < 20) {
      return false;
    }
    const res = await this.db.prepare(
      'UPDATE repositories SET is_pro = 1, license_key = ? WHERE owner = ? AND name = ?'
    ).bind(licenseKey, owner, name).run();
    return res.success;
  }

  async listRepos(): Promise<DbRepo[]> {
    if (!this.db) return [];
    const res = await this.db.prepare('SELECT * FROM repositories ORDER BY installed_at DESC').all();
    return (res.results || []) as DbRepo[];
  }

  async getRepoPRs(repoId: number): Promise<DbPR[]> {
    if (!this.db) return [];
    const res = await this.db.prepare(
      'SELECT * FROM pull_requests WHERE repo_id = ? ORDER BY created_at DESC'
    ).bind(repoId).all();
    return (res.results || []) as DbPR[];
  }

  async getPR(prId: string): Promise<DbPR | null> {
    if (!this.db) return null;
    const res = await this.db.prepare('SELECT * FROM pull_requests WHERE id = ?').bind(prId).first();
    return res as DbPR | null;
  }

  async getPRRuleHits(prId: string): Promise<DbRuleHit[]> {
    if (!this.db) return [];
    const res = await this.db.prepare('SELECT * FROM rule_hits WHERE pr_id = ?').bind(prId).all();
    return (res.results || []) as DbRuleHit[];
  }

  async getPRRisks(prId: string): Promise<DbRisk[]> {
    if (!this.db) return [];
    const res = await this.db.prepare('SELECT * FROM predicted_risks WHERE pr_id = ?').bind(prId).all();
    return (res.results || []) as DbRisk[];
  }

  async upsertPR(pr: Omit<DbPR, 'created_at' | 'updated_at'>): Promise<void> {
    if (!this.db) return;
    const now = new Date().toISOString();
    await this.db.prepare(
      `INSERT INTO pull_requests (
        id, repo_id, pr_number, title, state, overall_score,
        security_score, reliability_score, observability_score, performance_score, deployment_score,
        thought_process, created_at, updated_at
       ) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET 
         title=excluded.title, 
         state=excluded.state, 
         overall_score=excluded.overall_score,
         security_score=excluded.security_score, 
         reliability_score=excluded.reliability_score, 
         observability_score=excluded.observability_score, 
         performance_score=excluded.performance_score, 
         deployment_score=excluded.deployment_score,
         thought_process=excluded.thought_process,
         updated_at=excluded.updated_at`
    ).bind(
      pr.id, pr.repo_id, pr.pr_number, pr.title, pr.state, pr.overall_score,
      pr.security_score, pr.reliability_score, pr.observability_score, pr.performance_score, pr.deployment_score,
      pr.thought_process, now, now
    ).run();
  }

  async clearPRRuleHits(prId: string): Promise<void> {
    if (!this.db) return;
    await this.db.prepare('DELETE FROM rule_hits WHERE pr_id = ?').bind(prId).run();
  }

  async insertRuleHit(hit: Omit<DbRuleHit, 'created_at'>): Promise<void> {
    if (!this.db) return;
    await this.db.prepare(
      `INSERT OR REPLACE INTO rule_hits (id, pr_id, rule_id, dimension, penalty, title, description) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      hit.id, hit.pr_id, hit.rule_id, hit.dimension, hit.penalty, hit.title, hit.description
    ).run();
  }

  async clearPRRisks(prId: string): Promise<void> {
    if (!this.db) return;
    await this.db.prepare('DELETE FROM predicted_risks WHERE pr_id = ?').bind(prId).run();
  }

  async insertRisk(risk: Omit<DbRisk, 'created_at'>): Promise<void> {
    if (!this.db) return;
    await this.db.prepare(
      `INSERT OR REPLACE INTO predicted_risks (id, pr_id, pattern_id, title, location, why, severity) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      risk.id, risk.pr_id, risk.pattern_id, risk.title, risk.location, risk.why, risk.severity
    ).run();
  }
}
