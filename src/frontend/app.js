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

  // Polling tracker for active scanning
  let activePollInterval = null;
  let lastLoggedMessage = '';

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
    repoMemoryCountBadge: document.getElementById('repo-memory-count-badge'),
    thoughtProcessText: document.getElementById('thought-process-text'),
    // Vercel & Redesign HUD bindings
    btnConnectVercel: document.getElementById('btn-connect-vercel'),
    btnConnectVercelBody: document.getElementById('btn-connect-vercel-body'),
    vercelLinkModal: document.getElementById('vercel-link-modal'),
    btnCloseVercelModal: document.getElementById('btn-close-vercel-modal'),
    vercelLinkForm: document.getElementById('vercel-link-form'),
    vercelProjectSelect: document.getElementById('vercel-project-select'),
    repoHealthValue: document.getElementById('repo-health-value'),
    deployHealthValue: document.getElementById('deploy-health-value'),
    lastScanTime: document.getElementById('last-scan-time'),
    verifiedFindingsList: document.getElementById('verified-findings-list'),
    recommendedFixesList: document.getElementById('recommended-fixes-list'),
    predictConfidenceBadge: document.getElementById('predict-confidence-badge'),
    predictFailurePoint: document.getElementById('predict-failure-point'),
    predictFailureWhy: document.getElementById('predict-failure-why'),
    predictFailureImpact: document.getElementById('predict-failure-impact'),
    vercelStatusBadge: document.getElementById('vercel-status-badge'),
    vercelConnectedView: document.getElementById('vercel-connected-view'),
    vercelDisconnectedView: document.getElementById('vercel-disconnected-view'),
    vercelSuccessRate: document.getElementById('vercel-success-rate'),
    vercelFailedCount: document.getElementById('vercel-failed-count'),
    vercelDeployCount: document.getElementById('vercel-deploy-count'),
    vercelLastDeployDot: document.getElementById('vercel-last-deploy-dot'),
    vercelLastDeployStatus: document.getElementById('vercel-last-deploy-status'),
    vercelRiskDesc: document.getElementById('vercel-risk-desc')
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
    if (!Number.isFinite(numeric) || value === null || value === undefined) return null;
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
        
        try {
          const res = await authFetch(`/api/repos/${state.selectedRepo.owner}/${state.selectedRepo.name}/sync`, {
            method: 'POST'
          });
          if (res.ok) {
            startScanPolling(state.selectedRepo.owner, state.selectedRepo.name);
          } else {
            const data = await res.json();
            alert(`Scan failed: ${data.error || 'Unknown error'}`);
          }
        } catch (err) {
          alert('Failed to connect to scan endpoint.');
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

        try {
          const res = await authFetch(`/api/repos/${owner}/${repo}/sync`, {
            method: 'POST'
          });
          if (res.ok) {
            // Transition immediately to dashboard layout in scanning state
            el.emptyView.style.display = 'none';
            el.dashboardView.style.display = 'flex';
            el.currentRepoTitle.textContent = `${owner}/${repo}`;
            
            // Set basic values during transition
            el.proBadge.textContent = 'BASIC';
            el.proBadge.className = 'badge';
            el.btnActivateModal.style.display = 'block';
            el.memoryLockBadge.textContent = 'Pro Locked';
            el.memoryLockBadge.className = 'badge badge-memory';
            showNoPRsState();

            startScanPolling(owner, repo);
          } else {
            const data = await res.json();
            alert(`Import failed: ${data.error || 'Unknown error'}`);
          }
        } catch (err) {
          alert('Failed to connect to scan endpoint.');
        }
      });
    }
    
    // Connect Vercel triggers
    if (el.btnConnectVercel) {
      el.btnConnectVercel.addEventListener('click', loadVercelProjects);
    }
    if (el.btnConnectVercelBody) {
      el.btnConnectVercelBody.addEventListener('click', loadVercelProjects);
    }

    // Window message listener for connection popup
    window.addEventListener('message', async (event) => {
      if (event.data && event.data.type === 'vercel-connected') {
        alert('Vercel account connected successfully!');
        await loadVercelProjects();
      }
    });

    // Close Vercel Link modal
    if (el.btnCloseVercelModal) {
      el.btnCloseVercelModal.addEventListener('click', () => {
        el.vercelLinkModal.classList.remove('active');
      });
    }

    if (el.vercelLinkModal) {
      el.vercelLinkModal.addEventListener('click', (e) => {
        if (e.target === el.vercelLinkModal) {
          el.vercelLinkModal.classList.remove('active');
        }
      });
    }

    // Link form submit
    if (el.vercelLinkForm) {
      el.vercelLinkForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const projectId = el.vercelProjectSelect.value;
        const opt = el.vercelProjectSelect.options[el.vercelProjectSelect.selectedIndex];
        const projectName = opt.text;
        if (!state.selectedRepo || !projectId) return;

        try {
          const res = await authFetch(`/api/repos/${state.selectedRepo.owner}/${state.selectedRepo.name}/vercel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, projectName })
          });
          if (res.ok) {
            el.vercelLinkModal.classList.remove('active');
            alert('Vercel project linked successfully! Starting codebase/deployment sync scan...');
            startScanPolling(state.selectedRepo.owner, state.selectedRepo.name);
          } else {
            const data = await res.json();
            alert(`Link failed: ${data.error || 'Unknown error'}`);
          }
        } catch (err) {
          alert('Failed to link Vercel project.');
        }
      });
    }
  }

  async function loadVercelProjects() {
    try {
      const res = await authFetch('/api/vercel/projects');
      if (!res.ok) throw new Error('Failed to load Vercel projects');
      const data = await res.json();
      if (data.connected) {
        // Connected! Populate select dropdown
        el.vercelProjectSelect.innerHTML = '<option value="">-- Choose Vercel Project --</option>';
        data.projects.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.text = p.name;
          el.vercelProjectSelect.add(opt);
        });
        // Open linkage modal
        el.vercelLinkModal.classList.add('active');
      } else {
        // Not connected: open popup redirecting to OAuth Initiate
        const token = getJwt();
        const width = 600;
        const height = 700;
        const left = (window.screen.width / 2) - (width / 2);
        const top = (window.screen.height / 2) - (height / 2);
        window.open(`/api/auth/vercel/connect?token=${encodeURIComponent(token || '')}`, 'VercelConnectPopup', `width=${width},height=${height},left=${left},top=${top}`);
      }
    } catch (e) {
      console.error(e);
      alert('Failed to connect to Vercel API connection service.');
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

      // Handle ongoing scan status immediately on load
      if (data.repository.scan_status === 'scanning') {
        startScanPolling(owner, name);
      } else {
        stopScanPolling();
        const scanHud = document.getElementById('live-scan-hud');
        if (scanHud) scanHud.style.display = 'none';

        if (data.pullRequests.length > 0) {
          // Load latest scan
          loadPRScan(owner, name, data.pullRequests[0].pr_number);
        } else {
          showNoPRsState();
        }
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

  // 4. Polling Visualizer Logic (Live Scanning HUD)
  function startScanPolling(owner, name) {
    if (activePollInterval) return;

    const scanHud = document.getElementById('live-scan-hud');
    const logsEl = document.getElementById('live-scan-logs');
    const bar = document.getElementById('live-scan-progress-bar');
    const percentText = document.getElementById('live-scan-percent');

    if (scanHud) scanHud.style.display = 'block';
    if (logsEl) logsEl.innerHTML = '';
    if (bar) bar.style.width = '0%';
    if (percentText) percentText.textContent = '0%';
    
    lastLoggedMessage = '';

    // Disable triggers during scan
    if (el.btnSyncRepo) {
      el.btnSyncRepo.disabled = true;
      el.btnSyncRepo.innerHTML = '🔍 Scanning...';
    }
    if (el.btnEmptySync) {
      el.btnEmptySync.disabled = true;
      el.btnEmptySync.innerHTML = '🔍 Scanning...';
    }

    appendTerminalLog('SYSTEM', `Spawning Sentinel Code Analysis Agent...`, 'stage');

    activePollInterval = setInterval(async () => {
      try {
        const res = await authFetch(`/api/repos/${owner}/${name}`);
        if (!res.ok) throw new Error('Polling error');
        const data = await res.json();

        const repo = data.repository;
        const status = repo.scan_status || 'idle';
        const msg = repo.scan_message || '';

        // Calculate progress percentage based on 7 pipeline stages
        let pct = 0;
        if (msg.includes('Stage 1/7')) pct = 15;
        else if (msg.includes('Stage 2/7')) pct = 30;
        else if (msg.includes('Stage 3/7')) pct = 45;
        else if (msg.includes('Stage 4/7')) pct = 60;
        else if (msg.includes('Stage 5/7')) pct = 75;
        else if (msg.includes('Stage 6/7')) pct = 90;
        else if (status === 'completed') pct = 100;

        if (bar) bar.style.width = `${pct}%`;
        if (percentText) percentText.textContent = `${pct}%`;

        if (msg && msg !== lastLoggedMessage) {
          lastLoggedMessage = msg;
          let styleClass = 'info';
          if (msg.includes('Rule Hits') || msg.includes('risks')) styleClass = 'warning';
          if (msg.includes('failed') || msg.includes('Error')) styleClass = 'error';
          appendTerminalLog('AGENT', msg, styleClass);
        }

        if (status === 'completed') {
          appendTerminalLog('SUCCESS', 'Posture verification completed successfully!', 'success');
          stopScanPolling();

          // Reload repository details to update findings
          state.selectedRepo = repo;
          state.pullRequests = data.pullRequests;
          state.isPro = !!repo.is_pro;

          setTimeout(() => {
            if (scanHud) scanHud.style.display = 'none';
            updateDashboardHeader();
            populatePRSelector();
            loadRepoMemories(owner, name);
            if (data.pullRequests.length > 0) {
              loadPRScan(owner, name, data.pullRequests[0].pr_number);
            }
            loadRepositories(repo.id);
          }, 1800);

        } else if (status === 'failed') {
          appendTerminalLog('ERROR', `Scan aborted: ${msg}`, 'error');
          stopScanPolling();

          setTimeout(() => {
            if (scanHud) scanHud.style.display = 'none';
            alert(`Code scan failed: ${msg}`);
            loadRepository(owner, name);
            loadRepositories(repo.id);
          }, 2000);
        }

      } catch (err) {
        console.error('Scanning poll failure:', err);
      }
    }, 1500);
  }

  function stopScanPolling() {
    if (activePollInterval) {
      clearInterval(activePollInterval);
      activePollInterval = null;
    }
    if (el.btnSyncRepo) {
      el.btnSyncRepo.disabled = false;
      el.btnSyncRepo.innerHTML = '🔍 Scan Codebase';
    }
    if (el.btnEmptySync) {
      el.btnEmptySync.disabled = false;
      el.btnEmptySync.innerHTML = 'Import & Analyze Codebase';
    }
  }

  function appendTerminalLog(type, message, styleClass = 'info') {
    const logsEl = document.getElementById('live-scan-logs');
    if (!logsEl) return;

    const timeStr = new Date().toLocaleTimeString();
    const logItem = document.createElement('div');
    logItem.className = `log-line ${styleClass}`;
    logItem.innerHTML = `<span class="timestamp">[${timeStr}]</span> <span class="log-tag">[${type}]</span> ${escapeHtml(message)}`;
    
    logsEl.appendChild(logItem);
    logsEl.scrollTop = logsEl.scrollHeight;
  }

  // 5. Renderers
  function renderRepoList(activeId = null) {
    el.repoList.innerHTML = '';
    
    state.repositories.forEach(repo => {
      const li = document.createElement('li');
      const isActive = activeId ? repo.id === activeId : (state.selectedRepo && repo.id === state.selectedRepo.id);
      li.className = `repo-item ${isActive ? 'active' : ''}`;
      
      const proBadge = repo.is_pro ? '<span class="repo-pro-badge">PRO</span>' : '';

      li.innerHTML = `
        <div class="repo-icon">📦</div>
        <div class="repo-details">
          <div class="repo-name">${escapeHtml(repo.name)} ${proBadge}</div>
        </div>
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
      
      const prScore = clampScore(pr.overall_score);
      const scoreStr = prScore !== null ? `Score: ${prScore}` : 'unscanned';

      if (pr.pr_number === 0) {
        opt.text = `Baseline Scan - ${scoreStr}`;
      } else if (pr.pr_number < 0) {
        opt.text = `${pr.title} - ${scoreStr}`;
      } else {
        opt.text = `PR #${pr.pr_number} - ${scoreStr}`;
      }
      if (state.selectedPR && pr.pr_number === state.selectedPR.pr_number) {
        opt.selected = true;
      }
      el.prSelect.add(opt);
    });
  }

  function renderPRDetails(data) {
    const { pr, ruleHits, risks, patternMatches, vercelProject, vercelSnapshot } = data;
    
    // 1. Overall Score Ring Gauge
    let score = pr.combined_score !== null && pr.combined_score !== undefined ? clampScore(pr.combined_score) : clampScore(pr.overall_score);
    
    const circumference = 326; // 2 * pi * r (r=52)
    
    if (score === null) {
      el.scoreValue.textContent = '--';
      el.scoreRing.style.strokeDashoffset = circumference;
      el.scoreStatus.textContent = 'UNSCANNED';
      el.scoreStatus.className = 'score-status-badge';
      el.scoreStatus.style.background = 'rgba(255,255,255,0.03)';
      el.scoreStatus.style.color = 'var(--text-muted)';
      el.scoreRing.style.stroke = 'var(--text-muted)';
      el.scoreRing.style.filter = 'none';
    } else {
      el.scoreValue.textContent = score;
      const offset = circumference - (circumference * score) / 100;
      el.scoreRing.style.strokeDashoffset = offset;

      // Ring Color Grading
      if (score >= 85) {
        el.scoreRing.style.stroke = 'var(--success)';
        el.scoreRing.style.filter = 'drop-shadow(0 0 8px var(--success-glow))';
        el.scoreStatus.textContent = 'HEALTHY';
        el.scoreStatus.className = 'score-status-badge high';
        el.scoreStatus.style.background = 'var(--success-bg)';
        el.scoreStatus.style.color = 'var(--success)';
      } else if (score >= 70) {
        el.scoreRing.style.stroke = 'var(--warning)';
        el.scoreRing.style.filter = 'drop-shadow(0 0 8px var(--warning-glow))';
        el.scoreStatus.textContent = 'WARNING';
        el.scoreStatus.className = 'score-status-badge med';
        el.scoreStatus.style.background = 'var(--warning-bg)';
        el.scoreStatus.style.color = 'var(--warning)';
      } else {
        el.scoreRing.style.stroke = 'var(--error)';
        el.scoreRing.style.filter = 'drop-shadow(0 0 8px var(--error-glow))';
        el.scoreStatus.textContent = 'CRITICAL';
        el.scoreStatus.className = 'score-status-badge low';
        el.scoreStatus.style.background = 'var(--error-bg)';
        el.scoreStatus.style.color = 'var(--error)';
      }
    }

    // Sub scores
    if (el.repoHealthValue) {
      el.repoHealthValue.textContent = pr.overall_score !== null && pr.overall_score !== undefined ? `${clampScore(pr.overall_score)}/100` : '--/100';
    }
    if (el.deployHealthValue) {
      el.deployHealthValue.textContent = pr.deployment_health_score !== null && pr.deployment_health_score !== undefined ? `${clampScore(pr.deployment_health_score)}/100` : '--/100';
    }
    if (el.lastScanTime) {
      el.lastScanTime.textContent = pr.updated_at ? new Date(pr.updated_at).toLocaleString() : '--';
    }

    // Predict predictions rendering
    if (el.predictFailurePoint) {
      el.predictFailurePoint.textContent = pr.predicted_failure_point || 'No failure point predicted.';
    }
    if (el.predictFailureWhy) {
      el.predictFailureWhy.textContent = pr.predicted_failure_why || 'No explanation available.';
    }
    if (el.predictFailureImpact) {
      el.predictFailureImpact.textContent = pr.predicted_failure_impact || 'No estimated impact available.';
    }
    if (el.predictConfidenceBadge) {
      el.predictConfidenceBadge.textContent = pr.predicted_failure_confidence !== null && pr.predicted_failure_confidence !== undefined ? `${pr.predicted_failure_confidence}%` : '--%';
    }

    // Key Verified Findings (facts extracted)
    if (el.verifiedFindingsList) {
      el.verifiedFindingsList.innerHTML = '';
      if (!ruleHits || ruleHits.length === 0) {
        el.verifiedFindingsList.innerHTML = `<li style="color: var(--text-muted); font-size: 13px;">✓ All posture checks verified successfully.</li>`;
      } else {
        const displayHits = ruleHits.slice(0, 5);
        displayHits.forEach(hit => {
          const li = document.createElement('li');
          li.style.display = 'flex';
          li.style.alignItems = 'center';
          li.style.gap = '8px';
          li.style.color = '#fff';
          li.style.fontSize = '13px';
          li.innerHTML = `
            <span style="color: #EF4444; font-weight: bold;">✗</span>
            <span><strong>${escapeHtml(hit.dimension.toUpperCase())}:</strong> ${escapeHtml(hit.title || hit.rule_id)}</span>
          `;
          el.verifiedFindingsList.appendChild(li);
        });
      }
    }

    // Recommended Actions / Fixes
    if (el.recommendedFixesList) {
      el.recommendedFixesList.innerHTML = '';
      let recommendedFixes = [];
      if (pr.recommended_fixes) {
        try {
          recommendedFixes = JSON.parse(pr.recommended_fixes);
        } catch (e) {
          console.error('Failed to parse recommended_fixes:', e);
        }
      }
      if (!recommendedFixes || recommendedFixes.length === 0) {
        if (ruleHits && ruleHits.length > 0) {
          recommendedFixes = ruleHits.map(h => `Add ${h.rule_id.replace('no-', '').replace(/-/g, ' ')}`);
        }
      }
      if (!recommendedFixes || recommendedFixes.length === 0) {
        el.recommendedFixesList.innerHTML = `<li style="color: var(--text-muted); list-style: none;">No recommended actions. Repository complies with all verified posture rules.</li>`;
      } else {
        recommendedFixes.forEach(fix => {
          const li = document.createElement('li');
          li.style.marginBottom = '6px';
          li.innerHTML = `<span style="color: var(--text-bright);">${escapeHtml(fix)}</span>`;
          el.recommendedFixesList.appendChild(li);
        });
      }
    }

    // Vercel Panel
    if (el.vercelStatusBadge) {
      if (vercelProject) {
        el.vercelStatusBadge.textContent = `CONNECTED: ${vercelProject.project_name.toUpperCase()}`;
        el.vercelStatusBadge.style.color = '#10B981';
        el.vercelStatusBadge.style.background = 'rgba(16, 185, 129, 0.1)';
        
        if (el.vercelConnectedView) el.vercelConnectedView.style.display = 'block';
        if (el.vercelDisconnectedView) el.vercelDisconnectedView.style.display = 'none';

        if (vercelSnapshot) {
          if (el.vercelSuccessRate) el.vercelSuccessRate.textContent = `${Math.round(vercelSnapshot.success_rate * 100)}%`;
          if (el.vercelFailedCount) el.vercelFailedCount.textContent = vercelSnapshot.failed_count;
          if (el.vercelDeployCount) el.vercelDeployCount.innerHTML = `7d: ${vercelSnapshot.deploys_7d}<br/>30d: ${vercelSnapshot.deploys_30d}`;
          if (el.vercelLastDeployStatus) el.vercelLastDeployStatus.textContent = vercelSnapshot.last_status.toUpperCase();
          
          if (el.vercelLastDeployDot) {
            const status = vercelSnapshot.last_status.toLowerCase();
            let dotColor = 'var(--text-muted)';
            if (status === 'ready' || status === 'success') {
              dotColor = '#10B981';
            } else if (status === 'error' || status === 'failed' || status === 'canceled') {
              dotColor = '#EF4444';
            } else if (status === 'building' || status === 'queued') {
              dotColor = '#F59E0B';
            }
            el.vercelLastDeployDot.style.backgroundColor = dotColor;
          }

          if (el.vercelRiskDesc) {
            if (vercelSnapshot.failed_count > 0) {
              el.vercelRiskDesc.textContent = `Vercel build pipelines flag vulnerability with ${vercelSnapshot.failed_count} deployment failure(s) in the last 30 days. Last status: ${vercelSnapshot.last_status.toUpperCase()}.`;
              el.vercelRiskDesc.style.color = '#EF4444';
            } else {
              el.vercelRiskDesc.textContent = `All deployments are fully operational with a ${Math.round(vercelSnapshot.success_rate * 100)}% production success rate.`;
              el.vercelRiskDesc.style.color = 'var(--text-muted)';
            }
          }
        } else {
          if (el.vercelSuccessRate) el.vercelSuccessRate.textContent = '--';
          if (el.vercelFailedCount) el.vercelFailedCount.textContent = '--';
          if (el.vercelDeployCount) el.vercelDeployCount.textContent = '7d: -- / 30d: --';
          if (el.vercelLastDeployStatus) el.vercelLastDeployStatus.textContent = 'UNKNOWN';
          if (el.vercelLastDeployDot) el.vercelLastDeployDot.style.backgroundColor = 'var(--text-muted)';
          if (el.vercelRiskDesc) {
            el.vercelRiskDesc.textContent = 'Snapshot fetching active... Syncing current Vercel production metrics.';
            el.vercelRiskDesc.style.color = 'var(--text-muted)';
          }
        }
      } else {
        el.vercelStatusBadge.textContent = 'NOT CONNECTED';
        el.vercelStatusBadge.style.color = 'var(--text-muted)';
        el.vercelStatusBadge.style.background = 'rgba(255, 255, 255, 0.05)';
        
        if (el.vercelConnectedView) el.vercelConnectedView.style.display = 'none';
        if (el.vercelDisconnectedView) el.vercelDisconnectedView.style.display = 'block';
      }
    }

    // 2. Summary Header
    if (pr.pr_number === 0) {
      el.selectedPRTitle.textContent = pr.title;
    } else if (pr.pr_number < 0) {
      el.selectedPRTitle.textContent = pr.title;
    } else {
      el.selectedPRTitle.textContent = `PR #${pr.pr_number}: ${pr.title}`;
    }
    
    if (score === null) {
      el.analysisSummary.innerHTML = `No audit reports found. Click the <strong>Scan Codebase</strong> trigger above to generate scores and failure predictions.`;
      if (el.thoughtProcessText) {
        el.thoughtProcessText.textContent = "Initialize scan or select history log reference to display the engine's step-by-step security reasoning.";
      }
    } else {
      // Construct summary from risks / severity
      const criticalCount = risks.filter(r => r.severity === 'critical').length;
      const warningCount = risks.filter(r => r.severity === 'warning').length;
      
      let displaySummary = `Sentinel evaluated these PR changes and calculated a posture score of <strong>${score}/100</strong>. `;
      if (criticalCount > 0) {
        displaySummary += `The reasoning engine predicted <strong>${criticalCount} critical risk(s)</strong> that could cause production instability. `;
      } else if (warningCount > 0) {
        displaySummary += `Sentinel identified <strong>${warningCount} warning(s)</strong> within the PR diff. `;
      } else {
        displaySummary += `No significant risks were predicted in the code changes. `;
      }
      displaySummary += `Verify the rule detections and annotations below.`;
      
      let displayThought = pr.thought_process || "No detailed reasoning logs recorded for this scan. Deterministic verification was executed directly.";

      if (pr.thought_process && pr.thought_process.startsWith('SUMMARY:')) {
        const parts = pr.thought_process.split('\n\nTHOUGHT PROCESS:\n');
        if (parts.length > 1) {
          const summaryContent = parts[0].replace('SUMMARY:', '').trim();
          displaySummary = `<div class="llm-summary-box" style="margin-bottom: 14px; font-weight: 500; font-size: 13.5px; color: var(--text-bright); line-height: 1.6; border-left: 3px solid var(--primary); padding-left: 12px; background: rgba(0, 255, 102, 0.02); padding-top: 6px; padding-bottom: 6px;">${escapeHtml(summaryContent)}</div>` + displaySummary;
          displayThought = parts[1];
        }
      }

      // Dynamic Score Calculation Report
      const sec = pr.security_score !== undefined && pr.security_score !== null ? pr.security_score : '--';
      const rel = pr.reliability_score !== undefined && pr.reliability_score !== null ? pr.reliability_score : '--';
      const obs = pr.observability_score !== undefined && pr.observability_score !== null ? pr.observability_score : '--';
      const perf = pr.performance_score !== undefined && pr.performance_score !== null ? pr.performance_score : '--';
      const dep = pr.deployment_score !== undefined && pr.deployment_score !== null ? pr.deployment_score : '--';

      let scoreExplanation = `<div class="score-explanation-report" style="margin-top: 16px; font-size: 13px; color: var(--text-muted); line-height: 1.6; border-top: 1px dashed var(--border-hud); padding-top: 16px;">`;
      scoreExplanation += `<strong>🛡️ Score Calculation Report:</strong><br/>`;
      scoreExplanation += `The overall health score is a weighted combination of five postures: <br/>`;
      scoreExplanation += `<span style="font-family: 'JetBrains Mono', monospace; color: var(--primary);">Overall Score = (Security × 30%) + (Reliability × 25%) + (Observability × 15%) + (Performance × 15%) + (Deployment × 15%)</span><br/>`;
      scoreExplanation += `Specifically: <span style="font-family: 'JetBrains Mono', monospace;">(${sec} × 0.3) + (${rel} × 0.25) + (${obs} × 0.15) + (${perf} × 0.15) + (${dep} × 0.15) = <strong>${score !== null ? score : '--'}/100</strong></span>.<br/>`;

      if (ruleHits && ruleHits.length > 0) {
        scoreExplanation += `<div style="margin-top: 8px; color: var(--error);">⚠️ <strong>Deterministic Clamping Applied:</strong> `;
        const penaltyDetails = ruleHits.map(h => `"${escapeHtml(h.title || h.rule_id)}" (-${h.penalty} points to ${escapeHtml(h.dimension)})`).join(', ');
        scoreExplanation += `The overall posture was capped or reduced by deterministic checks: ${penaltyDetails}.`;
        scoreExplanation += `</div>`;
      } else {
        scoreExplanation += `<div style="margin-top: 8px; color: var(--success);">✓ <strong>Perfect Compliance:</strong> No deterministic rule violations or point deductions were flagged in this scan.</div>`;
      }
      scoreExplanation += `</div>`;

      el.analysisSummary.innerHTML = displaySummary + scoreExplanation;
      
      // Update thought process text
      if (el.thoughtProcessText) {
        el.thoughtProcessText.textContent = displayThought;
      }
    }

    // 3. Render Dimensions Postures
    const dims = [
      { key: 'security', name: 'security', color: '#EF4444' },
      { key: 'reliability', name: 'reliability', color: '#F59E0B' },
      { key: 'observability', name: 'observability', color: '#3B82F6' },
      { key: 'performance', name: 'performance', color: '#8B5CF6' },
      { key: 'deployment', name: 'deployment', color: '#10B981' }
    ];

    el.dimensionsContainer.innerHTML = '';
    dims.forEach(d => {
      const rawVal = pr[`${d.key}_score`];
      const scoreVal = rawVal !== undefined && rawVal !== null ? clampScore(rawVal) : null;
      const displayScore = scoreVal !== null ? `${scoreVal}/100` : '--/100';
      const barWidth = scoreVal !== null ? `${scoreVal}%` : '0%';
      const dimCard = document.createElement('div');
      dimCard.className = 'dimension-card';
      
      const hits = ruleHits.filter(h => h.dimension === d.key);
      const notesHtml = hits.length > 0
        ? hits.map(h => `<div class="note-hit">⚠️ ${escapeHtml(h.rule_id || h.title)} (-${escapeHtml(h.penalty)})</div>`).join('')
        : '<div class="note-none">Verified (no penalties)</div>';

      dimCard.innerHTML = `
        <div class="dim-header">
          <span class="dim-name">${escapeHtml(d.name)}</span>
          <span class="dim-score">${displayScore}</span>
        </div>
        <div class="dim-bar-wrapper">
          <div class="dim-bar" style="width: ${barWidth}; background: ${d.color}"></div>
        </div>
        <div class="dim-notes">
          ${notesHtml}
        </div>
      `;
      el.dimensionsContainer.appendChild(dimCard);
    });

    // 4. Render Reasoning / Predicted Risks (Grounded safely)
    if (el.risksList) {
      el.risksList.innerHTML = '';
      if (risks.length === 0) {
        el.risksList.innerHTML = `<div class="empty-state"><p>No predicted risks reported for this reference.</p></div>`;
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
    el.scoreRing.style.strokeDashoffset = 326;
    el.scoreStatus.textContent = 'NO SCANS';
    el.scoreStatus.className = 'score-status-badge';
    el.scoreStatus.style.background = 'rgba(255,255,255,0.03)';
    el.scoreStatus.style.color = 'var(--text-muted)';
    el.selectedPRTitle.textContent = 'No scans performed yet';
    el.analysisSummary.textContent = 'Run a manual sync scan or post a webhook check to audit this repository.';
    el.dimensionsContainer.innerHTML = '<div style="grid-column: 1/6; text-align: center; color: var(--text-muted); padding: 24px;">No scan dimension data available. Trigger a codebase scan above.</div>';
    
    if (el.risksList) {
      el.risksList.innerHTML = '<div class="empty-state"><p>Risk queue empty. Trigger scan to populate.</p></div>';
    }
    el.memoriesPanel.innerHTML = '<div class="empty-state"><p>Memory index empty.</p></div>';
    if (el.thoughtProcessText) {
      el.thoughtProcessText.textContent = "Run a codebase scan above to invoke the Groq reasoning engine and see step-by-step audit thoughts.";
    }

    if (el.repoHealthValue) el.repoHealthValue.textContent = '--/100';
    if (el.deployHealthValue) el.deployHealthValue.textContent = '--/100';
    if (el.lastScanTime) el.lastScanTime.textContent = '--';

    if (el.predictFailurePoint) el.predictFailurePoint.textContent = '--';
    if (el.predictFailureWhy) el.predictFailureWhy.textContent = '--';
    if (el.predictFailureImpact) el.predictFailureImpact.textContent = '--';
    if (el.predictConfidenceBadge) el.predictConfidenceBadge.textContent = '--%';

    if (el.verifiedFindingsList) {
      el.verifiedFindingsList.innerHTML = '<li style="color: var(--text-muted); font-size: 13px;">No verified findings recorded. Perform a scan.</li>';
    }
    if (el.recommendedFixesList) {
      el.recommendedFixesList.innerHTML = '<li style="color: var(--text-muted); list-style: none;">No actions recommended yet. Perform a scan.</li>';
    }

    if (el.vercelStatusBadge) {
      el.vercelStatusBadge.textContent = 'NOT CONNECTED';
      el.vercelStatusBadge.style.color = 'var(--text-muted)';
      el.vercelStatusBadge.style.background = 'rgba(255, 255, 255, 0.05)';
    }
    if (el.vercelConnectedView) el.vercelConnectedView.style.display = 'none';
    if (el.vercelDisconnectedView) el.vercelDisconnectedView.style.display = 'block';
  }
});
