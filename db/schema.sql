-- db/schema.sql

-- Repositories registered via GitHub App installation
CREATE TABLE IF NOT EXISTS repositories (
  id INTEGER PRIMARY KEY, -- GitHub Repository ID
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  current_score INTEGER DEFAULT NULL,
  license_key TEXT,
  is_pro BOOLEAN DEFAULT 0,
  scan_status TEXT DEFAULT 'idle',
  scan_message TEXT DEFAULT '',
  deployment_health_score INTEGER DEFAULT NULL,
  combined_score INTEGER DEFAULT NULL
);

-- Pull Request scans
CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY, -- owner/repo/pull/number
  repo_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL, -- 'open' | 'closed' | 'merged'
  overall_score INTEGER DEFAULT NULL,
  security_score INTEGER DEFAULT NULL,
  reliability_score INTEGER DEFAULT NULL,
  observability_score INTEGER DEFAULT NULL,
  performance_score INTEGER DEFAULT NULL,
  deployment_score INTEGER DEFAULT NULL,
  thought_process TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deployment_health_score INTEGER DEFAULT NULL,
  combined_score INTEGER DEFAULT NULL,
  predicted_failure_point TEXT DEFAULT NULL,
  predicted_failure_why TEXT DEFAULT NULL,
  predicted_failure_impact TEXT DEFAULT NULL,
  predicted_failure_confidence INTEGER DEFAULT NULL,
  recommended_fixes TEXT DEFAULT NULL, -- JSON stringified array of strings
  FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

-- Deterministic Rule Hits
CREATE TABLE IF NOT EXISTS rule_hits (
  id TEXT PRIMARY KEY, -- pr_id + rule_id
  pr_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  penalty INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(pr_id) REFERENCES pull_requests(id) ON DELETE CASCADE
);

-- Predicted Diff-level Risks (Groq LLM output)
CREATE TABLE IF NOT EXISTS predicted_risks (
  id TEXT PRIMARY KEY, -- Unique UUID/hash
  pr_id TEXT NOT NULL,
  pattern_id TEXT NOT NULL, -- e.g., 'missing-retry-on-external-call'
  title TEXT NOT NULL,
  location TEXT NOT NULL, -- e.g., 'src/checkout.ts#L45'
  why TEXT NOT NULL,
  severity TEXT NOT NULL, -- 'critical' | 'warning' | 'info'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(pr_id) REFERENCES pull_requests(id) ON DELETE CASCADE
);

-- Local fallback store for Parcle memories (when PARCLE_API_KEY is absent)
CREATE TABLE IF NOT EXISTS local_memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  pattern_id TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  tags TEXT NOT NULL, -- JSON-stringified array of tags
  resolved BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Vercel Integration Connections (linked to GitHub developer username/ID)
CREATE TABLE IF NOT EXISTS vercel_connections (
  user_id TEXT PRIMARY KEY, -- GitHub username
  access_token TEXT NOT NULL,
  team_id TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Vercel Project linkages
CREATE TABLE IF NOT EXISTS vercel_projects (
  repo_id INTEGER PRIMARY KEY, -- Linked GitHub repo ID
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

-- Deployment Metrics Snapshots
CREATE TABLE IF NOT EXISTS deployment_snapshots (
  repo_id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  success_rate REAL NOT NULL,
  failed_count INTEGER NOT NULL,
  last_status TEXT NOT NULL,
  deploys_7d INTEGER NOT NULL,
  deploys_30d INTEGER NOT NULL,
  score INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

