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
    formError: document.getElementById('form-error')
  };

  // 1. Initial Load
  init();

  function init() {
    loadRepositories();
    setupEventListeners();
  }

  // 2. Event Listeners Setup
  function setupEventListeners() {
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
        const res = await fetch('/api/pro/activate', {
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
      if (prNumber) {
        loadPRScan(state.selectedRepo.owner, state.selectedRepo.name, prNumber);
      }
    });
  }

  // 3. API Loaders
  async function loadRepositories(activeId = null) {
    try {
      const res = await fetch('/api/repos');
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
      const res = await fetch(`/api/repos/${owner}/${name}`);
      if (!res.ok) throw new Error('API fetch failed');
      const data = await res.json();
      
      state.selectedRepo = data.repository;
      state.pullRequests = data.pullRequests;
      state.isPro = !!data.repository.is_pro;

      updateDashboardHeader();
      populatePRSelector();

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

  async function loadPRScan(owner, name, prNumber) {
    try {
      const res = await fetch(`/api/repos/${owner}/${name}/pr/${prNumber}`);
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
      
      const proBadge = repo.is_pro ? '<span style="font-size: 8px; color: var(--accent-pro); margin-left: 4px;">[PRO]</span>' : '';
      
      // Select score classification
      let scoreClass = 'high';
      if (repo.current_score < 70) scoreClass = 'low';
      else if (repo.current_score < 85) scoreClass = 'med';

      li.innerHTML = `
        <div class="repo-icon">📦</div>
        <div class="repo-details">
          <div class="repo-name">${repo.owner}/${repo.name} ${proBadge}</div>
        </div>
        <div class="repo-score ${scoreClass}">${repo.current_score}/100</div>
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
      opt.text = `PR #${pr.pr_number} - Score: ${pr.overall_score}`;
      if (state.selectedPR && pr.pr_number === state.selectedPR.pr_number) {
        opt.selected = true;
      }
      el.prSelect.add(opt);
    });
  }

  function renderPRDetails(data) {
    const { pr, ruleHits, risks, patternMatches } = data;
    
    // 1. Overall Score Ring Gauge
    const score = pr.overall_score;
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
    el.selectedPRTitle.textContent = `PR #${pr.pr_number}: ${pr.title}`;
    
    // Construct summary from risks / severity
    const criticalCount = risks.filter(r => r.severity === 'critical').length;
    const warningCount = risks.filter(r => r.severity === 'warning').length;
    
    let summaryText = `Sentinel evaluated this PR changes and calculated a posture score of **${score}/100**. `;
    if (criticalCount > 0) {
      summaryText += `Our reasoning engine predicted **${criticalCount} critical risk(s)** that could cause production instability. `;
    } else if (warningCount > 0) {
      summaryText += `We identified **${warningCount} minor warnings** within the PR diff. `;
    } else {
      summaryText += `No significant risks were predicted in the code changes. `;
    }
    summaryText += `Verify the rule detections and annotations below.`;
    
    el.analysisSummary.innerHTML = summaryText;

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
      const scoreVal = pr[`${d.key}_score`] !== undefined ? pr[`${d.key}_score`] : 100;
      const dimCard = document.createElement('div');
      dimCard.className = 'card dimension-card';
      
      const hits = ruleHits.filter(h => h.dimension === d.key);
      const notesHtml = hits.length > 0
        ? hits.map(h => `<div class="note-hit">⚠️ ${h.title} (-${h.penalty})</div>`).join('')
        : '<div class="note-none">Verified (no penalties)</div>';

      dimCard.innerHTML = `
        <div class="dim-header">
          <span class="dim-name">${d.name}</span>
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
        item.className = 'risk-item';
        item.innerHTML = `
          <div class="risk-item-header">
            <span class="risk-title">${risk.title}</span>
            <span class="risk-severity ${risk.severity}">${risk.severity}</span>
          </div>
          <div class="risk-location">${risk.location}</div>
          <div class="risk-why">${risk.why}</div>
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
            Inciting Pattern: <strong>${hit.title}</strong> (${prRef}, ${dateStr})
          </div>
          <div class="memory-match-text">
            ${m.content}
          </div>
        `;
        el.memoriesPanel.appendChild(item);
      });
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
