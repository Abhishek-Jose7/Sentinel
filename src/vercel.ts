// src/vercel.ts

export interface VercelMetrics {
  success_rate: number; // 0 to 1
  failed_count: number;
  last_status: string; // e.g. 'READY', 'ERROR'
  deploys_7d: number;
  deploys_30d: number;
}

export class VercelClient {
  private accessToken: string | null;
  private teamId: string | null;

  constructor(accessToken: string | null = null, teamId: string | null = null) {
    this.accessToken = accessToken;
    this.teamId = teamId;
  }

  // Exchanges OAuth code for Access Token
  async exchangeOAuthCode(
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
    codeVerifier?: string
  ): Promise<{ access_token: string; user_id: string; team_id: string | null }> {
    const params = new URLSearchParams();
    params.append('code', code);
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('redirect_uri', redirectUri);
    params.append('grant_type', 'authorization_code');
    if (codeVerifier) {
      params.append('code_verifier', codeVerifier);
    }

    const res = await fetch('https://api.vercel.com/login/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Vercel OAuth exchange failed: ${res.status} ${text}`);
    }

    const data = await res.json() as any;
    console.log('Vercel OAuth response keys:', Object.keys(data));

    let userId = data.user_id || '';
    if (!userId && data.id_token) {
      try {
        const payloadPart = data.id_token.split('.')[1];
        const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
        const decoded = atob(base64);
        const payload = JSON.parse(decoded);
        userId = payload.sub || '';
      } catch (e) {
        console.error('Failed to parse id_token payload:', e);
      }
    }

    return {
      access_token: data.access_token,
      user_id: userId,
      team_id: data.team_id || data.teamId || null
    };
  }

  // Fetch all projects for the Vercel connection
  async fetchProjects(): Promise<any[]> {
    if (!this.accessToken) {
      throw new Error('VercelClient not authenticated.');
    }

    let url = 'https://api.vercel.com/v10/projects';
    if (this.teamId) {
      url += `?teamId=${this.teamId}`;
    }

    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    });

    const text = await res.text();
    console.log('Vercel projects response status:', res.status, 'body:', text);

    if (!res.ok) {
      throw new Error(`Failed to fetch Vercel projects: ${res.status} ${text}`);
    }

    const data = JSON.parse(text) as any;
    return data.projects || [];
  }

  // Fetch all teams for the Vercel connection
  async fetchTeams(): Promise<any[]> {
    if (!this.accessToken) {
      throw new Error('VercelClient not authenticated.');
    }

    const res = await fetch('https://api.vercel.com/v2/teams', {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch Vercel teams: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as any;
    return data.teams || [];
  }

  // Fetch projects from personal account and all accessible teams
  async fetchAllProjects(): Promise<{ projects: any[]; error?: string }> {
    // 1. Fetch default projects (personal or the scoped team)
    let personalProjects: any[] = [];
    let fetchError: string | undefined = undefined;
    try {
      personalProjects = await this.fetchProjects();
      // Tag each default project with teamId (or null if personal)
      personalProjects.forEach(p => p.teamId = this.teamId || null);
    } catch (e) {
      console.error('Failed to fetch default projects:', e);
      fetchError = e instanceof Error ? e.message : String(e);
    }

    // 2. Fetch teams (only if not already scoped to a specific team)
    let teams: any[] = [];
    if (!this.teamId) {
      try {
        teams = await this.fetchTeams();
      } catch (e) {
        console.error('Failed to fetch teams:', e);
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('forbidden') || msg.includes('403')) {
          fetchError = (fetchError ? fetchError + '; ' : '') + 'Forbidden listing teams: Please ensure your Vercel OAuth App has "Team details: Read" permissions enabled in your Vercel Developer settings.';
        }
      }
    }

    // 3. Fetch projects for each team
    const teamProjectsPromises = teams.map(async (team) => {
      try {
        const clientForTeam = new VercelClient(this.accessToken, team.id);
        const projects = await clientForTeam.fetchProjects();
        // Tag each team project with teamId
        projects.forEach(p => p.teamId = team.id);
        return projects;
      } catch (e) {
        console.error(`Failed to fetch projects for team ${team.name}:`, e);
        return [];
      }
    });

    const teamProjectsResults = await Promise.all(teamProjectsPromises);
    const allProjects = [...personalProjects];
    for (const projects of teamProjectsResults) {
      allProjects.push(...projects);
    }

    return { projects: allProjects, error: fetchError };
  }

  // Fetch recent deployments for a specific project
  async fetchDeployments(projectId: string, limit = 30): Promise<any[]> {
    if (!this.accessToken) {
      throw new Error('VercelClient not authenticated.');
    }

    let url = `https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=${limit}`;
    if (this.teamId) {
      url += `&teamId=${this.teamId}`;
    }

    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch Vercel deployments: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as any;
    return data.deployments || [];
  }

  // Calculate deployment metrics deterministically
  calculateDeploymentMetrics(deployments: any[]): VercelMetrics {
    if (!deployments || deployments.length === 0) {
      return {
        success_rate: 1.0,
        failed_count: 0,
        last_status: 'NONE',
        deploys_7d: 0,
        deploys_30d: 0
      };
    }

    // Sort deployments by creation date descending (most recent first)
    const sorted = [...deployments].sort((a, b) => b.created - a.created);
    const lastStatus = sorted[0].state || 'UNKNOWN';

    const nowMs = Date.now();
    const ms7d = 7 * 24 * 60 * 60 * 1000;
    const ms30d = 30 * 24 * 60 * 60 * 1000;

    let deploys7d = 0;
    let deploys30d = 0;
    let successCount = 0;
    let errorCount = 0;

    for (const d of sorted) {
      const createdAge = nowMs - Number(d.created);
      
      if (createdAge <= ms7d) {
        deploys7d++;
      }
      if (createdAge <= ms30d) {
        deploys30d++;
      }

      const state = String(d.state).toUpperCase();
      if (state === 'READY') {
        successCount++;
      } else if (state === 'ERROR') {
        errorCount++;
      }
    }

    const totalRated = successCount + errorCount;
    const successRate = totalRated > 0 ? successCount / totalRated : 1.0;

    return {
      success_rate: successRate,
      failed_count: errorCount,
      last_status: lastStatus,
      deploys_7d: deploys7d,
      deploys_30d: deploys30d
    };
  }

  // Calculate Deployment Health score with specific deductions
  calculateDeploymentHealthScore(metrics: VercelMetrics, deployments: any[]): number {
    let score = 100;

    // 1. Last deployment failed: -10
    const lastState = String(metrics.last_status).toUpperCase();
    if (lastState === 'ERROR') {
      score -= 10;
    }

    // 2. Deployment failure rate > 20%: -15
    if (metrics.success_rate < 0.8) {
      score -= 15;
    }

    // 3. No successful deployment in 30 days: -10
    const nowMs = Date.now();
    const ms30d = 30 * 24 * 60 * 60 * 1000;
    const hasSuccessfulDeploy30d = deployments.some(d => {
      const age = nowMs - Number(d.created);
      return age <= ms30d && String(d.state).toUpperCase() === 'READY';
    });

    if (!hasSuccessfulDeploy30d && deployments.length > 0) {
      score -= 10;
    }

    return Math.max(0, Math.min(100, score));
  }
}
