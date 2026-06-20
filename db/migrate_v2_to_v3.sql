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
