// src/test-runner.ts

import { runDeterministicChecks, applyPenalties, RuleHit } from './rules';
import { ParcleClient } from './parcle';
import { GroqEngine } from './groq';
import { buildPRComment, buildPatternMatchSection } from './github';

// Mock Cloudflare D1 Database
class MockD1Database {
  public store: Record<string, any[]> = {
    repositories: [],
    pull_requests: [],
    rule_hits: [],
    predicted_risks: [],
    local_memories: []
  };

  prepare(sql: string) {
    const db = this;
    return {
      bind(...args: any[]) {
        return {
          async run() {
            db.executeWrite(sql, args);
            return { success: true, results: [] };
          },
          async first() {
            return db.executeSelectFirst(sql, args);
          },
          async all() {
            const results = db.executeSelectAll(sql, args);
            return { results, success: true };
          }
        };
      }
    };
  }

  private executeWrite(sql: string, args: any[]) {
    const cleanSql = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    
    if (cleanSql.includes('insert into repositories')) {
      const id = args[0];
      const owner = args[1];
      const name = args[2];
      const idx = this.store.repositories.findIndex(r => r.id === id);
      const row = { id, owner, name, installed_at: new Date().toISOString(), current_score: 100, is_pro: 0, license_key: null };
      if (idx >= 0) {
        this.store.repositories[idx].owner = owner;
        this.store.repositories[idx].name = name;
      } else {
        this.store.repositories.push(row);
      }
    } else if (cleanSql.includes('update repositories set current_score')) {
      const score = args[0];
      const id = args[1];
      const repo = this.store.repositories.find(r => r.id === id);
      if (repo) repo.current_score = score;
    } else if (cleanSql.includes('update repositories set is_pro')) {
      const license = args[0];
      const owner = args[1];
      const name = args[2];
      const repo = this.store.repositories.find(r => r.owner === owner && r.name === name);
      if (repo) {
        repo.is_pro = 1;
        repo.license_key = license;
      }
    } else if (cleanSql.includes('insert into pull_requests')) {
      const id = args[0];
      const repo_id = args[1];
      const pr_number = args[2];
      const title = args[3];
      const state = args[4];
      const overall_score = args[5];
      const security_score = args[6];
      const reliability_score = args[7];
      const observability_score = args[8];
      const performance_score = args[9];
      const deployment_score = args[10];

      const idx = this.store.pull_requests.findIndex(p => p.id === id);
      const row = {
        id, repo_id, pr_number, title, state, overall_score,
        security_score, reliability_score, observability_score, performance_score, deployment_score,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      };
      if (idx >= 0) {
        Object.assign(this.store.pull_requests[idx], row);
      } else {
        this.store.pull_requests.push(row);
      }
    } else if (cleanSql.includes('delete from rule_hits')) {
      const prId = args[0];
      this.store.rule_hits = this.store.rule_hits.filter(h => h.pr_id !== prId);
    } else if (cleanSql.includes('insert into rule_hits')) {
      const id = args[0];
      const pr_id = args[1];
      const rule_id = args[2];
      const dimension = args[3];
      const penalty = args[4];
      const title = args[5];
      const description = args[6];
      this.store.rule_hits.push({ id, pr_id, rule_id, dimension, penalty, title, description, created_at: new Date().toISOString() });
    } else if (cleanSql.includes('delete from predicted_risks')) {
      const prId = args[0];
      this.store.predicted_risks = this.store.predicted_risks.filter(r => r.pr_id !== prId);
    } else if (cleanSql.includes('insert into predicted_risks')) {
      const id = args[0];
      const pr_id = args[1];
      const pattern_id = args[2];
      const title = args[3];
      const location = args[4];
      const why = args[5];
      const severity = args[6];
      this.store.predicted_risks.push({ id, pr_id, pattern_id, title, location, why, severity, created_at: new Date().toISOString() });
    } else if (cleanSql.includes('insert into local_memories')) {
      const id = args[0];
      const content = args[1];
      const pattern_id = args[2];
      const repo_name = args[3];
      const pr_number = args[4];
      const tags = args[5];
      const resolved = args[6];
      this.store.local_memories.push({ id, content, pattern_id, repo_name, pr_number, tags, resolved, created_at: new Date().toISOString() });
    }
  }

  private executeSelectFirst(sql: string, args: any[]): any {
    const cleanSql = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (cleanSql.includes('from repositories where owner =')) {
      return this.store.repositories.find(r => r.owner === args[0] && r.name === args[1]) || null;
    } else if (cleanSql.includes('from pull_requests where id =')) {
      return this.store.pull_requests.find(p => p.id === args[0]) || null;
    }
    return null;
  }

  private executeSelectAll(sql: string, args: any[]): any[] {
    const cleanSql = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (cleanSql.includes('from repositories order by')) {
      return this.store.repositories;
    } else if (cleanSql.includes('from pull_requests where repo_id =')) {
      return this.store.pull_requests.filter(p => p.repo_id === args[0]);
    } else if (cleanSql.includes('from rule_hits where pr_id =')) {
      return this.store.rule_hits.filter(h => h.pr_id === args[0]);
    } else if (cleanSql.includes('from predicted_risks where pr_id =')) {
      return this.store.predicted_risks.filter(r => r.pr_id === args[0]);
    } else if (cleanSql.includes('from local_memories where pattern_id =') && cleanSql.includes('repo_name =')) {
      return this.store.local_memories.filter(m => m.pattern_id === args[0] && m.repo_name === args[1]);
    } else if (cleanSql.includes('from local_memories where pattern_id =')) {
      return this.store.local_memories.filter(m => m.pattern_id === args[0]);
    }
    return [];
  }
}

// Mock global fetch for testing APIs
function setupGlobalFetchMock() {
  (globalThis as any).fetch = async (url: string, options?: any) => {
    const urlStr = String(url);
    
    // GitHub token request
    if (urlStr.includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'mock_github_installation_token' }), { status: 200 });
    }
    
    // GitHub PR diff
    if (urlStr.includes('/pulls/') && options?.headers?.Accept?.includes('diff')) {
      return new Response(`diff --git a/src/checkout.ts b/src/checkout.ts
index 0000000..1111111 100644
--- a/src/checkout.ts
+++ b/src/checkout.ts
@@ -12,4 +12,8 @@ export async function processCheckout(cart: Cart) {
   // Perform checkout billing
   await stripe.charge(cart.total);
+  
+  // Missing error wrapping:
+  await db.save(cart);
+  
   return { success: true };
 }`, { status: 200 });
     }

     // Groq completions
     if (urlStr.includes('api.groq.com')) {
       const body = JSON.parse(options.body);
       const prompt = body.messages?.[1]?.content || '';
       
       // Mock response structure
       const mockAnalysis = {
         dimensions: {
           security: 85,
           reliability: 60,
           observability: 75,
           performance: 90,
           deployment: 80
         },
         risks: [
           {
             id: 'unhandled-async',
             title: 'Unwrapped database async call',
             location: 'src/checkout.ts#L15',
             why: 'The call to db.save() is awaited without surrounding try/catch block, leaving it prone to unhandled promises rejection.',
             severity: 'critical'
           }
         ],
         summary: 'The pull request implements stripe billing but introduces an unhandled async saving vulnerability.'
       };

       return new Response(JSON.stringify({
         choices: [{ message: { content: JSON.stringify(mockAnalysis) } }]
       }), { status: 200 });
     }

     // Parcle endpoints
     if (urlStr.includes('api.parcle.ai')) {
       return new Response(JSON.stringify({ success: true, memories: [] }), { status: 200 });
     }

     return new Response(JSON.stringify({ success: true }), { status: 200 });
   };
}

async function runTests() {
  console.log('🧪 RUNNING SENTINEL V2 INTEGRATION TEST SUITE...');
  setupGlobalFetchMock();

  const mockDb = new MockD1Database();

  // Test 1: Deterministic Rule Engine
  console.log('\n--- Test 1: Deterministic Rule Engine ---');
  const mockFiles = {
    'package.json': '{"dependencies": {}}',
    'wrangler.toml': 'name = "test-worker"',
    'src/index.ts': 'console.log("no health route, no logs, no env validation");\nprocess.env.DB_URL;'
  };
  const mockDiff = 'await db.save(data);'; // unwrapped async call

  const hits = runDeterministicChecks({ files: mockFiles, diff: mockDiff });
  console.log('Rule Detections count:', hits.length);
  hits.forEach(h => console.log(`  [Hit] ID: ${h.id} (${h.dimension}) - Penalty: -${h.penalty}`));

  const expectedIds = ['no-rate-limit', 'no-health-endpoint', 'no-env-validation', 'no-structured-logging', 'unhandled-async'];
  const allIdsMatch = expectedIds.every(id => hits.some(h => h.id === id));
  if (allIdsMatch) {
    console.log('✅ Test 1 Passed: All 5 posture flaws detected successfully!');
  } else {
    console.error('❌ Test 1 Failed: Some rule hits are missing.');
  }

  // Test 2: Dimension Clamping (Hybrid Scoring)
  console.log('\n--- Test 2: Hybrid Scoring Clamping ---');
  const initialLLM = {
    security: 90,
    reliability: 95,
    observability: 90,
    performance: 85,
    deployment: 80
  };

  const { dimensions, penaltiesByDimension } = applyPenalties(initialLLM, hits);
  console.log('Initial Reliability:', initialLLM.reliability);
  console.log('Clamped Reliability (penalty ceiling 100 - 15 rateLimit - 10 unhandledAsync = 75):', dimensions.reliability);
  console.log('Clamped Observability (penalty ceiling 100 - 10 health - 10 logging = 80):', dimensions.observability);

  if (dimensions.reliability === 75 && dimensions.observability === 80) {
    console.log('✅ Test 2 Passed: Score clamping applied correctly!');
  } else {
    console.error('❌ Test 2 Failed: Penalty clamping math is incorrect.');
  }

  // Test 3: Recall -> Reason -> Store Memory Loop
  console.log('\n--- Test 3: Parcle Client & D1 Memory Loop ---');
  const parcle = new ParcleClient(null, mockDb); // Uses D1 local memories table

  // Seed memory with an incident
  await parcle.storePattern(
    'unwrapped db.save call in src/checkout.ts previously broke stripe transaction handling.',
    'unhandled-async',
    'acme/storefront',
    { prNumber: 31 }
  );
  
  // Recall memory by pattern and repo
  const recalled = await parcle.recallByPattern('unhandled-async', 'acme/storefront');
  console.log('Recalled memory matches count:', recalled.length);
  if (recalled.length > 0) {
    console.log('  Recalled content:', recalled[0].content);
    console.log('  Recalled metadata:', JSON.stringify(recalled[0].metadata));
    console.log('✅ Test 3 Passed: Memory successfully stored and recalled via pattern tags!');
  } else {
    console.error('❌ Test 3 Failed: Stored memory was not recalled.');
  }

  // Test 4: Format Markdown Section
  console.log('\n--- Test 4: PR Comment Markdown Formatter ---');
  const matchedHistory = [
    { hit: hits.find(h => h.id === 'unhandled-async')!, memories: recalled }
  ];

  const patternSection = buildPatternMatchSection(matchedHistory);
  console.log('Formatted Pattern Match Section:\n');
  console.log(patternSection);

  const commentMarkdown = buildPRComment(
    42,
    74,
    dimensions,
    penaltiesByDimension,
    [
      {
        id: 'unhandled-async',
        title: 'Unwrapped database async call',
        location: 'src/checkout.ts#L15',
        why: 'The call to db.save() is awaited without surrounding try/catch block.',
        severity: 'critical'
      }
    ],
    patternSection,
    'PR introduces unwrapped saving vulnerability.'
  );

  if (commentMarkdown.includes('🧠 Pattern Match') && commentMarkdown.includes('capped by:')) {
    console.log('✅ Test 4 Passed: PR comment conforms to specification!');
  } else {
    console.error('❌ Test 4 Failed: PR Comment formatted incorrectly.');
  }

  console.log('\n🌟 ALL INTEGRATION TESTS EXECUTION COMPLETED.');
}

runTests().catch(e => {
  console.error('Test execution failed:', e);
});
