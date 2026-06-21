-- Migration number: 0001 	 2026-06-21T03:12:10.497Z

-- Add Vercel columns to repositories
ALTER TABLE repositories ADD COLUMN deployment_health_score INTEGER DEFAULT NULL;
ALTER TABLE repositories ADD COLUMN combined_score INTEGER DEFAULT NULL;

-- Add Vercel and Executive findings columns to pull_requests
ALTER TABLE pull_requests ADD COLUMN deployment_health_score INTEGER DEFAULT NULL;
ALTER TABLE pull_requests ADD COLUMN combined_score INTEGER DEFAULT NULL;
ALTER TABLE pull_requests ADD COLUMN predicted_failure_point TEXT DEFAULT NULL;
ALTER TABLE pull_requests ADD COLUMN predicted_failure_why TEXT DEFAULT NULL;
ALTER TABLE pull_requests ADD COLUMN predicted_failure_impact TEXT DEFAULT NULL;
ALTER TABLE pull_requests ADD COLUMN predicted_failure_confidence INTEGER DEFAULT NULL;
ALTER TABLE pull_requests ADD COLUMN recommended_fixes TEXT DEFAULT NULL;

-- Vercel Integration Connections (linked to GitHub developer username/ID)
CREATE TABLE IF NOT EXISTS vercel_connections (
  user_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  team_id TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Vercel Project linkages
CREATE TABLE IF NOT EXISTS vercel_projects (
  repo_id INTEGER PRIMARY KEY,
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
