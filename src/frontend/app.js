// src/frontend/app.js

document.addEventListener('DOMContentLoaded', () => {
  // App State
  let state = {
    repositories: [],
    selectedRepo: null,
    pullRequests: [],
    selectedPR: null,
    isPro: false
  };

  // DOM Elements
  const el = {
    repoList: document.getElementById('repo-list'),
    dashboardView: document.getElementById('dashboard-view'),
    emptyView: document.getElementById('empty-view'),
    currentRepoTitle: document.getElementById('current-repo-title'),
    proBadge: document.getElementById('pro-badge'),
    btnActivateModal: document.getElementById('btn-activate-modal'),
    prSelect: document.getElementById('pr-select'),
    scoreRing: document.getElementById('score-ring'),
    scoreValue: document.getElementById('score-value'),
    scoreStatus: document.getElementById('score-status'),
    selectedPRTitle: document.getElementById('selected-pr-title'),
    analysisSummary: document.getElementById('analysis-summary'),
    dimensionsContainer: document.getElementById('dimensions-container'),
    risksList: document.getElementById('risks-list'),
    memoriesPanel: document.getElementById('memories-panel'),
    memoryLockBadge: document.getElementById('memory-lock-badge'),
    proModal: document.getElementById('pro-modal'),
    btnCloseModal: document.getElementById('btn-close-modal'),
    proForm: document.getElementById('pro-form'),
    licenseKeyInput: document.getElementById('license-key'),
    formError: document.getElementById('form-error'),
    btnSyncRepo: document.getElementById('btn-sync-repo'),
    emptySyncForm: document.getElementById('empty-sync-form'),
    syncOwnerInput: document.getElementById('sync-owner'),
    syncRepoInput: document.getElementById('sync-repo'),
    btnEmptySync: document.getElementById('btn-empty-sync'),
    loginOverlay: document.getElementById('login-overlay'),
    btnGithubLogin: document.getElementById('btn-github-login'),
    userBadgeContainer: document.getElementById('user-badge-container'),
    userAvatar: document.getElementById('user-avatar'),
    userName: document.getElementById('user-name'),
    userRole: document.getElementById('user-role'),
    repoMemoriesList: document.getElementById('repo-memories-list'),
    repoMemoryCountBadge: document.getElementById('repo-memory-count-badge')
  };

  // 1. Initial Load
  init();

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]);
  }

  function clampScore(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(100, numeric));
  }

  function getJwt() {
    return localStorage.getItem('sentinel_jwt');
  }

  async function authFetch(url, options = {}) {
    const token = getJwt();
    if (token) {
      options.headers = {
        ...options.headers,
        'Authorization': `Bearer ${token}`
      };
    }
    const res = await fetch(url, options);
    if (res.status === 401) {
      signOut();
    }
    return res;
  }

  function showDashboard() {
    el.loginOverlay.style.display = 'none';
    const userStr = localStorage.getItem('sentinel_user');
    if (userStr) {
      const user = JSON.parse(userStr);
      el.userName.textContent = user.login;
      el.userRole.textContent = 'GitHub Session';
      if (user.avatar_url) {
        el.userAvatar.innerHTML = `<img src="${user.avatar_url}" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;" />`;
      }
    }
    loadRepositories();
  }

  function showLoginOverlay() {
    el.loginOverlay.style.display = 'flex';
    el.dashboardView.style.display = 'none';
    el.emptyView.style.display = 'none';
  }

  function signOut() {
    localStorage.removeItem('sentinel_jwt');
    localStorage.removeItem('sentinel_user');
    showLoginOverlay();
  }

  // 1. Initial Load
  async function init() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    
    if (code) {
      el.loginOverlay.style.display = 'flex';
      const btn = el.btnGithubLogin;
      btn.disabled = true;
      btn.innerHTML = '🔄 Authenticating...';
      
      try {
        const res = await fetch('/api/auth/github', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (res.ok) {
          localStorage.setItem('sentinel_jwt', data.token);
          localStorage.setItem('sentinel_user', JSON.stringify(data.user));
          window.history.replaceState({}, document.title, window.location.pathname);
          showDashboard();
        } else {
          alert(`Authentication failed: ${data.error || 'Unknown error'}`);
          signOut();
        }
      } catch (err) {
        alert('Failed to connect to authentication server.');
        signOut();
      }
    } else {
      const jwtToken = getJwt();
      if (jwtToken) {
        showDashboard();
      } else {
        showLoginOverlay();
      }
    }
    
    setupEventListeners();
  }

  // 2. Event Listeners Setup
  function setupEventListeners() {
    // GitHub Login Click
    el.btnGithubLogin.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/config');
        const config = await res.json();
        if (config.client_id) {
          window.location.href = `https://github.com/login/oauth/authorize?client_id=${config.client_id}&scope=repo,read:org`;
        } else {
          alert('GitHub Client ID is not configured on backend.');
        }
      } catch (e) {
        alert('Failed to fetch authentication config.');
      }
    });

    // User badge Click (Sign out)
    el.userBadgeContainer.addEventListener('click', () => {
      if (confirm('Are you sure you want to sign out?')) {
        signOut();
      }
    });

    // Open/Close Activation Modal
    el.btnActivateModal.addEventListener('click', () => {
      el.formError.textContent = '';
      el.licenseKeyInput.value = '';
      el.proModal.classList.add('active');
    });

    el.btnCloseModal.addEventListener('click', () => {
      el.proModal.classList.remove('active');
    });

    // Close modal on background click
    el.proModal.addEventListener('click', (e) => {
      if (e.target === el.proModal) {
        el.proModal.classList.remove('active');
      }
    });

    // Handle Pro Form Submit
    el.proForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = el.licenseKeyInput.value.trim();
      if (!state.selectedRepo) return;

      try {
        const res = await authFetch('/api/pro/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            owner: state.selectedRepo.owner,
            repo: state.selectedRepo.name,
            licenseKey: key
          })
        });

        const data = await res.json();
        if (res.ok) {
          el.proModal.classList.remove('active');
          // Reload current repo status
          await loadRepository(state.selectedRepo.owner, state.selectedRepo.name);
          // Re-load repositories list to update badges
          loadRepositories(state.selectedRepo.id);
        } else {
          el.formError.textContent = data.error || 'Failed to activate license key';
        }
      } catch (err) {
        el.formError.textContent = 'Connection error, please try again.';
      }
    });

    // PR Select Change
    el.prSelect.addEventListener('change', (e) => {
      const prNumber = parseInt(e.target.value);
      loadPRScan(state.selectedRepo.owner, state.selectedRepo.name, prNumber);
    });

    // Scan Repository button
    if (el.btnSyncRepo) {
      el.btnSyncRepo.addEventListener('click', async () => {
        if (!state.selectedRepo) return;
        const btn = el.btnSyncRepo;
        const originalText = btn.innerHTML;
        
        btn.disabled = true;
        btn.innerHTML = '🔍 Scanning...';
        
        try {
          const res = await authFetch(`/api/repos/${state.selectedRepo.owner}/${state.selectedRepo.name}/sync`, {
            method: 'POST'
          });
          const data = await res.json();
          if (res.ok) {
            alert('Scan queued successfully. Repository baseline and commits are analyzing in the background. Dashboard will reload in 5 seconds.');
            setTimeout(() => {
              loadRepository(state.selectedRepo.owner, state.selectedRepo.name);
            }, 5000);
          } else {
            alert(`Scan failed: ${data.error || 'Unknown error'}`);
          }
        } catch (err) {
          alert('Failed to connect to scan endpoint.');
        } finally {
          btn.disabled = false;
          btn.innerHTML = originalText;
        }
      });
    }

    // Empty state: Manual Import & Sync
    if (el.emptySyncForm) {
      el.emptySyncForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const owner = el.syncOwnerInput.value.trim();
        const repo = el.syncRepoInput.value.trim();
        if (!owner || !repo) return;

        const btn = el.btnEmptySync;
        const originalText = btn.innerHTML;
        
        btn.disabled = true;
        btn.innerHTML = '🔍 Scanning...';

        try {
          const res = await authFetch(`/api/repos/${owner}/${repo}/sync`, {
            method: 'POST'
          });
          const data = await res.json();
          if (res.ok) {
            alert('Repository import and scan queued successfully. Baseline scan and commits will backfill in the background. The dashboard will load in 5 seconds.');
            setTimeout(async () => {
              await loadRepositories();
            }, 5000);
          } else {
            alert(`Import failed: ${data.error || 'Unknown error'}`);
          }
        } catch (err) {
          alert('Failed to connect to scan endpoint.');
        } finally {
          btn.disabled = false;
          btn.innerHTML = originalText;
        }
      });
    }
  }

  // 3. API Loaders
  async function loadRepositories(activeId = null) {
    try {
      const res = await authFetch('/api/repos');
      if (!res.ok) throw new Error('API fetch failed');
      const data = await res.json();
      state.repositories = data;
      renderRepoList(activeId);
      
      if (data.length > 0 && !state.selectedRepo) {
        // Auto load first repo
        loadRepository(data[0].owner, data[0].name);
      } else if (data.length === 0) {
        showEmptyState();
      }
    } catch (err) {
      console.error('Error loading repositories:', err);
      el.repoList.innerHTML = `<li class="loading-item" style="color: var(--error);">Error loading repos</li>`;
    }
  }

  async function loadRepository(owner, name) {
    try {
      const res = await authFetch(`/api/repos/${owner}/${name}`);
      if (!res.ok) throw new Error('API fetch failed');
      const data = await res.json();
      
      state.selectedRepo = data.repository;
      state.pullRequests = data.pullRequests;
      state.isPro = !!data.repository.is_pro;

      updateDashboardHeader();
      populatePRSelector();
      loadRepoMemories(owner, name);

      if (data.pullRequests.length > 0) {
        // Load latest scan
        loadPRScan(owner, name, data.pullRequests[0].pr_number);
      } else {
        showNoPRsState();
      }
    } catch (err) {
      console.error('Error loading repository details:', err);
    }
  }

  async function loadRepoMemories(owner, name) {
    try {
      const res = await authFetch(`/api/repos/${owner}/${name}/memories`);
      if (!res.ok) throw new Error('API fetch memories failed');
      const data = await res.json();
      renderRepoMemories(data.memories || []);
    } catch (err) {
      console.error('Error loading repository memories:', err);
      el.repoMemoriesList.innerHTML = `<div class="empty-state"><p style="color: var(--error);">Error loading Parcle memories.</p></div>`;
      el.repoMemoryCountBadge.textContent = '0 Memories';
    }
  }

  async function loadPRScan(owner, name, prNumber) {
    try {
      const res = await authFetch(`/api/repos/${owner}/${name}/pr/${prNumber}`);
      if (!res.ok) throw new Error('API fetch failed');
      const data = await res.json();

      state.selectedPR = data.pr;
      renderPRDetails(data);
    } catch (err) {
      console.error('Error loading PR scan:', err);
    }
  }

  // 4. Renderers
  function renderRepoList(activeId = null) {
    el.repoList.innerHTML = '';
    
    state.repositories.forEach(repo => {
      const li = document.createElement('li');
      const isActive = activeId ? repo.id === activeId : (state.selectedRepo && repo.id === state.selectedRepo.id);
      li.className = `repo-item ${isActive ? 'active' : ''}`;
      
      const proBadge = repo.is_pro ? '<span class="repo-pro-badge">PRO</span>' : '';
      const repoScore = clampScore(repo.current_score);
      
      // Select score classification
      let scoreClass = 'high';
      if (repoScore < 70) scoreClass = 'low';
      else if (repoScore < 85) scoreClass = 'med';

      li.innerHTML = `
        <div class="repo-icon">📦</div>
        <div class="repo-details">
          <div class="repo-name">${escapeHtml(repo.name)} ${proBadge}</div>
        </div>
        <div class="repo-score ${scoreClass}">${repoScore}/100</div>
      `;

      li.addEventListener('click', () => {
        // Highlight active item
        document.querySelectorAll('.repo-item').forEach(item => item.classList.remove('active'));
        li.classList.add('active');
        loadRepository(repo.owner, repo.name);
      });

      el.repoList.appendChild(li);
    });
  }

  function updateDashboardHeader() {
    el.emptyView.style.display = 'none';
    el.dashboardView.style.display = 'flex';
    
    el.currentRepoTitle.textContent = `${state.selectedRepo.owner}/${state.selectedRepo.name}`;
    
    if (state.isPro) {
      el.proBadge.textContent = 'PRO';
      el.proBadge.className = 'badge pro';
      el.btnActivateModal.style.display = 'none';
      el.memoryLockBadge.textContent = 'PRO Active';
      el.memoryLockBadge.className = 'badge badge-memory active';
    } else {
      el.proBadge.textContent = 'BASIC';
      el.proBadge.className = 'badge';
      el.btnActivateModal.style.display = 'block';
      el.memoryLockBadge.textContent = 'Pro Locked';
      el.memoryLockBadge.className = 'badge badge-memory';
    }
  }

  function populatePRSelector() {
    el.prSelect.innerHTML = '';
    
    if (state.pullRequests.length === 0) {
      const opt = document.createElement('option');
      opt.text = 'No scan history';
      el.prSelect.add(opt);
      el.prSelect.disabled = true;
      return;
    }

    el.prSelect.disabled = false;
    state.pullRequests.forEach(pr => {
      const opt = document.createElement('option');
      opt.value = pr.pr_number;
      if (pr.pr_number === 0) {
        opt.text = `Baseline Scan - Score: ${clampScore(pr.overall_score)}`;
      } else if (pr.pr_number < 0) {
        opt.text = `${pr.title} - Score: ${clampScore(pr.overall_score)}`;
      } else {
        opt.text = `PR #${pr.pr_number} - Score: ${clampScore(pr.overall_score)}`;
      }
      if (state.selectedPR && pr.pr_number === state.selectedPR.pr_number) {
        opt.selected = true;
      }
      el.prSelect.add(opt);
    });
  }

  function renderPRDetails(data) {
    const { pr, ruleHits, risks, patternMatches } = data;
    
    // 1. Overall Score Ring Gauge
    const score = clampScore(pr.overall_score);
    el.scoreValue.textContent = score;
    
    const circumference = 314; // 2 * pi * r (r=50)
    const offset = circumference - (circumference * score) / 100;
    el.scoreRing.style.strokeDashoffset = offset;

    // Ring Color Grading
    if (score >= 85) {
      el.scoreRing.style.stroke = 'var(--success)';
      el.scoreRing.style.filter = 'drop-shadow(0 0 6px rgba(16, 185, 129, 0.4))';
      el.scoreStatus.textContent = 'EXCELLENT';
      el.scoreStatus.style.color = 'var(--success)';
    } else if (score >= 70) {
      el.scoreRing.style.stroke = 'var(--warning)';
      el.scoreRing.style.filter = 'drop-shadow(0 0 6px rgba(245, 158, 11, 0.4))';
      el.scoreStatus.textContent = 'WARN';
      el.scoreStatus.style.color = 'var(--warning)';
    } else {
      el.scoreRing.style.stroke = 'var(--error)';
      el.scoreRing.style.filter = 'drop-shadow(0 0 6px rgba(239, 68, 68, 0.4))';
      el.scoreStatus.textContent = 'CRITICAL POSTURE';
      el.scoreStatus.style.color = 'var(--error)';
    }

    // 2. Summary
    if (pr.pr_number === 0) {
      el.selectedPRTitle.textContent = pr.title;
    } else if (pr.pr_number < 0) {
      el.selectedPRTitle.textContent = pr.title;
    } else {
      el.selectedPRTitle.textContent = `PR #${pr.pr_number}: ${pr.title}`;
    }
    
    // Construct summary from risks / severity
    const criticalCount = risks.filter(r => r.severity === 'critical').length;
    const warningCount = risks.filter(r => r.severity === 'warning').length;
    
    let summaryText = `Sentinel evaluated these PR changes and calculated a posture score of <strong>${score}/100</strong>. `;
    if (criticalCount > 0) {
      summaryText += `The reasoning engine predicted <strong>${criticalCount} critical risk(s)</strong> that could cause production instability. `;
    } else if (warningCount > 0) {
      summaryText += `Sentinel identified <strong>${warningCount} warning(s)</strong> within the PR diff. `;
    } else {
      summaryText += `No significant risks were predicted in the code changes. `;
    }
    summaryText += `Verify the rule detections and annotations below.`;
    
    // Dynamic Score Calculation Report
    const sec = clampScore(pr.security_score !== undefined ? pr.security_score : 100);
    const rel = clampScore(pr.reliability_score !== undefined ? pr.reliability_score : 100);
    const obs = clampScore(pr.observability_score !== undefined ? pr.observability_score : 100);
    const perf = clampScore(pr.performance_score !== undefined ? pr.performance_score : 100);
    const dep = clampScore(pr.deployment_score !== undefined ? pr.deployment_score : 100);

    let scoreExplanation = `<div class="score-explanation-report" style="margin-top: 16px; font-size: 13px; color: var(--text-secondary); line-height: 1.6; border-top: 1px dashed rgba(255,255,255,0.08); padding-top: 16px;">`;
    scoreExplanation += `<strong>🛡️ Score Calculation Report:</strong><br/>`;
    scoreExplanation += `The overall health score is a weighted combination of five postures: <br/>`;
    scoreExplanation += `<span style="font-family: monospace; color: var(--primary);">Overall Score = (Security × 30%) + (Reliability × 25%) + (Observability × 15%) + (Performance × 15%) + (Deployment × 15%)</span><br/>`;
    scoreExplanation += `Specifically: <span style="font-family: monospace;">(${sec} × 0.3) + (${rel} × 0.25) + (${obs} × 0.15) + (${perf} × 0.15) + (${dep} × 0.15) = <strong>${score}/100</strong></span>.<br/>`;

    if (ruleHits && ruleHits.length > 0) {
      scoreExplanation += `<div style="margin-top: 8px; color: var(--error);">⚠️ <strong>Deterministic Clamping Applied:</strong> `;
      const penaltyDetails = ruleHits.map(h => `"${escapeHtml(h.title || h.rule_id)}" (-${h.penalty} points to ${escapeHtml(h.dimension)})`).join(', ');
      scoreExplanation += `The overall posture was capped or reduced by deterministic checks: ${penaltyDetails}.`;
      scoreExplanation += `</div>`;
    } else {
      scoreExplanation += `<div style="margin-top: 8px; color: var(--success);">✓ <strong>Perfect Compliance:</strong> No deterministic rule violations or point deductions were flagged in this scan.</div>`;
    }
    scoreExplanation += `</div>`;

    el.analysisSummary.innerHTML = summaryText + scoreExplanation;

    // 3. Render Dimensions Postures
    const dims = [
      { key: 'security', name: 'security', color: 'linear-gradient(90deg, #f43f5e, #ec4899)' },
      { key: 'reliability', name: 'reliability', color: 'linear-gradient(90deg, #f59e0b, #eab308)' },
      { key: 'observability', name: 'observability', color: 'linear-gradient(90deg, #3b82f6, #06b6d4)' },
      { key: 'performance', name: 'performance', color: 'linear-gradient(90deg, #8b5cf6, #a855f7)' },
      { key: 'deployment', name: 'deployment', color: 'linear-gradient(90deg, #10b981, #14b8a6)' }
    ];

    el.dimensionsContainer.innerHTML = '';
    dims.forEach(d => {
      const scoreVal = pr[`${d.key}_score`] !== undefined ? clampScore(pr[`${d.key}_score`]) : 100;
      const dimCard = document.createElement('div');
      dimCard.className = 'card dimension-card';
      
      const hits = ruleHits.filter(h => h.dimension === d.key);
      const notesHtml = hits.length > 0
        ? hits.map(h => `<div class="note-hit">⚠️ ${escapeHtml(h.rule_id || h.title)} (-${escapeHtml(h.penalty)})</div>`).join('')
        : '<div class="note-none">Verified (no penalties)</div>';

      dimCard.innerHTML = `
        <div class="dim-header">
          <span class="dim-name">${escapeHtml(d.name)}</span>
          <span class="dim-score">${scoreVal}/100</span>
        </div>
        <div class="dim-bar-wrapper">
          <div class="dim-bar" style="width: ${scoreVal}%; background: ${d.color}"></div>
        </div>
        <div class="dim-notes">
          ${notesHtml}
        </div>
      `;
      el.dimensionsContainer.appendChild(dimCard);
    });

    // 4. Render Reasoning / Predicted Risks
    el.risksList.innerHTML = '';
    if (risks.length === 0) {
      el.risksList.innerHTML = `<div class="empty-state"><p>No predicted risks reported for this pull request.</p></div>`;
    } else {
      risks.forEach(risk => {
        const item = document.createElement('div');
        const severity = ['critical', 'warning', 'info'].includes(risk.severity) ? risk.severity : 'warning';
        item.className = 'risk-item';
        item.innerHTML = `
          <div class="risk-item-header">
            <span class="risk-title">${escapeHtml(risk.title)}</span>
            <span class="risk-severity ${severity}">${severity}</span>
          </div>
          <div class="risk-location">${escapeHtml(risk.location)}</div>
          <div class="risk-why">${escapeHtml(risk.why)}</div>
        `;
        el.risksList.appendChild(item);
      });
    }

    // 5. Render Memory Panel
    renderMemoryPanel(patternMatches);
  }

  function renderMemoryPanel(patternMatches) {
    if (!state.isPro) {
      el.memoriesPanel.className = 'memories-panel locked';
      el.memoriesPanel.innerHTML = `
        <div class="empty-state">
          <div style="font-size: 24px; margin-bottom: 8px;">🔒</div>
          <p>Activate <strong>Sentinel Pro</strong> to view recurring security matches and historical incident regressions.</p>
        </div>
      `;
      return;
    }

    el.memoriesPanel.className = 'memories-panel';
    el.memoriesPanel.innerHTML = '';

    if (!patternMatches || patternMatches.length === 0) {
      el.memoriesPanel.innerHTML = `
        <div class="empty-state">
          <div style="font-size: 24px; margin-bottom: 8px;">🧠</div>
          <p>This is the first time Sentinel has observed these posture issues. Future PRs matching this pattern will flag historical context here.</p>
        </div>
      `;
      return;
    }

    patternMatches.forEach(match => {
      const { hit, memories } = match;
      memories.forEach(m => {
        const item = document.createElement('div');
        item.className = 'memory-match-item';
        
        // Convert timestamp
        const dateStr = m.metadata?.ts 
          ? new Date(m.metadata.ts).toLocaleDateString()
          : 'recent';
        const prRef = m.metadata?.prNumber ? `PR #${m.metadata.prNumber}` : 'Incident';

        item.innerHTML = `
          <div class="memory-match-header">
            Inciting Pattern: <strong>${escapeHtml(hit.title)}</strong> (${escapeHtml(prRef)}, ${escapeHtml(dateStr)})
          </div>
          <div class="memory-match-text">
            ${escapeHtml(m.content)}
          </div>
        `;
        el.memoriesPanel.appendChild(item);
      });
    });
  }

  function renderRepoMemories(memories) {
    el.repoMemoryCountBadge.textContent = `${memories.length} Stored Memories`;
    el.repoMemoriesList.innerHTML = '';
    
    if (memories.length === 0) {
      el.repoMemoriesList.innerHTML = `
        <div class="empty-state">
          <p>No memories stored in Parcle yet. Run a scan to build memory context.</p>
        </div>
      `;
      return;
    }

    memories.forEach(m => {
      const item = document.createElement('div');
      item.className = 'memory-match-item';
      
      const dateStr = m.metadata?.ts 
        ? new Date(m.metadata.ts).toLocaleString()
        : 'recent';
      const prRef = m.metadata?.prNumber !== undefined 
        ? (m.metadata.prNumber === 0 ? 'Baseline Scan' : m.metadata.prNumber < 0 ? `Commit Scan` : `PR #${m.metadata.prNumber}`) 
        : 'Scan';
      const patternId = m.metadata?.pattern || 'general';

      item.innerHTML = `
        <div class="memory-match-header" style="color: var(--primary); display: flex; justify-content: space-between; align-items: center;">
          <span>Pattern: <strong>${escapeHtml(patternId)}</strong> (${escapeHtml(prRef)})</span>
          <span style="color: var(--text-muted); font-size: 11px;">${escapeHtml(dateStr)}</span>
        </div>
        <div class="memory-match-text" style="border-left: 2px solid var(--primary); background: rgba(99, 102, 241, 0.02);">
          ${escapeHtml(m.content)}
        </div>
      `;
      el.repoMemoriesList.appendChild(item);
    });
  }

  function showEmptyState() {
    el.dashboardView.style.display = 'none';
    el.emptyView.style.display = 'flex';
  }

  function showNoPRsState() {
    el.scoreValue.textContent = '--';
    el.scoreRing.style.strokeDashoffset = 314;
    el.scoreStatus.textContent = 'NO SCANS';
    el.scoreStatus.style.color = 'var(--text-muted)';
    el.selectedPRTitle.textContent = 'No scans performed yet';
    el.analysisSummary.textContent = 'Post a webhook check to audit this repository.';
    el.dimensionsContainer.innerHTML = '<div style="grid-column: 1/6; text-align: center; color: var(--text-muted);">No scan dimension data</div>';
    el.risksList.innerHTML = '<div class="empty-state"><p>Audit queue is empty.</p></div>';
    el.memoriesPanel.innerHTML = '<div class="empty-state"><p>Audit queue is empty.</p></div>';
  }
});
