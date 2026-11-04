/**
 * Trove Media Vault - Ingestion Activity Monitor
 * Fetches and displays the latest ingestion run and item states from Cloudflare D1.
 * On-demand manual refresh only — no continuous polling or background timers.
 */
(function() {
  window.Trove = window.Trove || {};

  const CONFIG = window.APP_CONFIG || {};
  const storage = CONFIG.storage || {};
  const { MotionAnim, formatDuration, formatBytes, escapeHtml } = window.Trove.utils || {};

  const ActivityManager = {
    elements: {},
    currentRunId: null,
    isLoading: false,

    get isOpen() {
      return this.elements.modal && this.elements.modal.style.display === 'flex';
    },

    init() {
      this.elements = {
        modal: document.getElementById('activity-modal'),
        backdrop: document.getElementById('activity-backdrop'),
        closeBtn: document.getElementById('close-activity-modal-btn'),
        dismissBtn: document.getElementById('dismiss-activity-btn'),
        refreshBtn: document.getElementById('refresh-activity-btn'),
        refreshIcon: document.getElementById('activity-refresh-icon'),
        activityBtn: document.getElementById('activity-btn'),
        mobileActivityBtn: document.getElementById('mobile-activity-btn'),
        activityStatusPill: document.getElementById('activity-status-pill'),
        activityPulseDot: document.getElementById('activity-pulse-dot'),
        activityStepInfo: document.getElementById('activity-step-info'),
        activityTimeElapsed: document.getElementById('activity-time-elapsed'),
        activityProgressBar: document.getElementById('activity-progress-bar'),
        activityCounts: document.getElementById('activity-counts'),
        activityItemsList: document.getElementById('activity-items-list'),
        activityGithubLink: document.getElementById('activity-github-link'),
        activityRunIdLabel: document.getElementById('activity-run-id-label'),
        mobileNavMenu: document.getElementById('mobile-nav-menu')
      };

      this.setupEventListeners();
    },

    setupEventListeners() {
      if (this.elements.activityBtn) {
        this.elements.activityBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.open();
        });
      }
      if (this.elements.mobileActivityBtn) {
        this.elements.mobileActivityBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.elements.mobileNavMenu) this.elements.mobileNavMenu.classList.add('hidden');
          this.open();
        });
      }
      if (this.elements.closeBtn) {
        this.elements.closeBtn.addEventListener('click', () => this.close());
      }
      if (this.elements.dismissBtn) {
        this.elements.dismissBtn.addEventListener('click', () => this.close());
      }
      if (this.elements.refreshBtn) {
        this.elements.refreshBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.fetchStatus(true);
        });
      }
      if (this.elements.backdrop) {
        this.elements.backdrop.addEventListener('click', () => this.close());
      }
      if (this.elements.modal) {
        this.elements.modal.addEventListener('click', (e) => {
          const card = this.elements.modal.querySelector('.relative');
          if (card && !card.contains(e.target)) {
            this.close();
          }
        });
      }
    },

    open(runId = null) {
      if (!this.elements.modal) return;
      if (runId) {
        this.currentRunId = runId;
      } else {
        this.currentRunId = sessionStorage.getItem('trove_current_run_id') || sessionStorage.getItem('trove_current_job_id') || null;
      }

      this.elements.modal.style.display = 'flex';
      if (window.lucide) window.lucide.createIcons();
      if (MotionAnim) MotionAnim.animateSheetIn(this.elements.modal);

      // Fetch latest on open
      this.fetchStatus();
    },

    close() {
      if (!this.isOpen) return;
      if (MotionAnim) {
        MotionAnim.animateSheetOut(this.elements.modal, () => {
          this.elements.modal.style.display = 'none';
        });
      } else {
        this.elements.modal.style.display = 'none';
      }
    },

    // Backward compatibility stubs
    startPolling() {},
    stopPolling() {},
    showButton() {},
    hideButton() {},

    async fetchStatus(isManual = false) {
      if (this.isLoading) return;
      this.isLoading = true;

      if (isManual) {
        // Explicit manual refresh checks for latest/active run
        this.currentRunId = null;
      }

      if (this.elements.refreshBtn) {
        this.elements.refreshBtn.disabled = true;
        this.elements.refreshBtn.classList.add('opacity-75', 'pointer-events-none');
        const span = this.elements.refreshBtn.querySelector('span');
        if (span) span.innerText = 'Refreshing...';
      }
      if (this.elements.refreshIcon) {
        this.elements.refreshIcon.classList.add('animate-spin');
      }

      const workerUrl = CONFIG.getWorkerEndpoint ? CONFIG.getWorkerEndpoint('/ingest') : null;
      const workerToken = localStorage.getItem(storage.workerTokenKey) || '';

      if (!workerUrl) {
        this.renderEmpty('Cloudflare Worker endpoint not configured in settings.');
        this._finishLoading();
        return;
      }

      try {
        const reqRunId = this.currentRunId || '';
        const fetchUrl = `${workerUrl.replace(/\/+$/, '')}/status${reqRunId ? '?run_id=' + encodeURIComponent(reqRunId) : ''}`;
        const headers = {};
        if (workerToken) {
          headers['Authorization'] = `Bearer ${workerToken}`;
          headers['X-API-Key'] = workerToken;
        }

        const res = await fetch(fetchUrl, { headers, cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (data.success && data.run) {
            this.render(data.run, data.items || []);
          } else {
            this.renderEmpty(data.message || 'No ingestion runs recorded yet.');
          }
        } else {
          this.renderEmpty(`Worker returned status ${res.status}.`);
        }
      } catch (err) {
        console.warn('Activity fetch note:', err);
        this.renderEmpty('Could not connect to Worker. Check network or settings.');
      } finally {
        this._finishLoading();
      }
    },

    _finishLoading() {
      this.isLoading = false;
      if (this.elements.refreshBtn) {
        this.elements.refreshBtn.disabled = false;
        this.elements.refreshBtn.classList.remove('opacity-75', 'pointer-events-none');
        const span = this.elements.refreshBtn.querySelector('span');
        if (span) span.innerText = 'Refresh';
      }
      if (this.elements.refreshIcon) {
        this.elements.refreshIcon.classList.remove('animate-spin');
      }
      if (window.lucide) window.lucide.createIcons();
    },

    renderEmpty(message) {
      if (this.elements.activityStatusPill) {
        this.elements.activityStatusPill.innerText = 'Idle';
        this.elements.activityStatusPill.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-gray-100 dark:bg-[#202532] text-stone-brown dark:text-[#9aa4b2]';
      }
      if (this.elements.activityPulseDot) {
        this.elements.activityPulseDot.className = 'w-2 h-2 rounded-full bg-stone-brown/40 dark:bg-[#758092]';
      }
      if (this.elements.activityStepInfo) this.elements.activityStepInfo.innerText = 'Ready';
      if (this.elements.activityTimeElapsed) this.elements.activityTimeElapsed.innerText = '--:--';
      if (this.elements.activityProgressBar) this.elements.activityProgressBar.style.width = '0%';
      if (this.elements.activityCounts) this.elements.activityCounts.innerText = '0 / 0 completed';
      if (this.elements.activityGithubLink) this.elements.activityGithubLink.classList.add('hidden');
      if (this.elements.activityRunIdLabel) this.elements.activityRunIdLabel.innerText = '';
      if (this.elements.activityItemsList) {
        this.elements.activityItemsList.innerHTML = `
          <div class="p-4 text-center text-xs text-stone-brown dark:text-[#9aa4b2] bg-almond-cream/15 dark:bg-[#1a1e26] rounded-xl border border-dashed border-almond-cream dark:border-[#2b3240] flex flex-col items-center gap-1.5">
            <i data-lucide="info" class="w-4 h-4 text-stone-brown/60 dark:text-[#758092]"></i>
            <span>${escapeHtml(message)}</span>
          </div>
        `;
      }
    },

    render(run, items = []) {
      const isRunning = run.status === 'in_progress' || run.status === 'queued';
      const isCompleted = run.status === 'completed';

      if (isCompleted || run.status === 'failed') {
        sessionStorage.removeItem('trove_current_run_id');
        sessionStorage.removeItem('trove_current_job_id');
      }

      // Duration & elapsed time
      const startTime = run.started_at || run.created_at || Date.now();
      const endTime = isRunning ? Date.now() : (run.ended_at || run.updated_at || Date.now());
      const elapsedSec = Math.max(0, Math.floor((endTime - startTime) / 1000));

      if (this.elements.activityTimeElapsed) {
        this.elements.activityTimeElapsed.innerText = formatDuration ? formatDuration(elapsedSec) : `${elapsedSec}s`;
      }

      // Counts
      const totalExpected = Math.max(run.total_tracks || items.length || 0, 1);
      const succeededCount = run.succeeded_tracks ?? items.filter(it => it.status === 'succeeded' || it.status === 'skipped_archive').length;
      const failedCount = run.failed_tracks ?? items.filter(it => it.status === 'failed').length;
      const processedCount = succeededCount + failedCount;
      const activeItem = items.find(it => it.status === 'downloading');

      // Header Pill & Pulse
      if (this.elements.activityStatusPill && this.elements.activityPulseDot) {
        if (isRunning) {
          const pillText = run.status === 'queued' ? 'Queued' : 'In Progress';
          this.elements.activityStatusPill.innerText = pillText;
          this.elements.activityStatusPill.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300';
          this.elements.activityPulseDot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse';
        } else if (isCompleted) {
          const pillText = failedCount > 0 ? 'Completed with errors' : 'Completed';
          this.elements.activityStatusPill.innerText = pillText;
          this.elements.activityStatusPill.className = failedCount > 0
            ? 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300'
            : 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300';
          this.elements.activityPulseDot.className = failedCount > 0 ? 'w-2 h-2 rounded-full bg-amber-500' : 'w-2 h-2 rounded-full bg-emerald-500';
        } else {
          this.elements.activityStatusPill.innerText = 'Failed';
          this.elements.activityStatusPill.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-red-100 dark:bg-red-950/60 text-red-800 dark:text-red-300';
          this.elements.activityPulseDot.className = 'w-2 h-2 rounded-full bg-red-500';
        }
      }

      // Step Info
      if (this.elements.activityStepInfo) {
        if (isRunning) {
          this.elements.activityStepInfo.innerText = activeItem 
            ? `Downloading: ${activeItem.title || activeItem.url}` 
            : (run.status === 'queued' ? 'Queued in GitHub Actions...' : `Processing ${totalExpected} track(s)...`);
        } else if (isCompleted) {
          this.elements.activityStepInfo.innerText = `Finished (${succeededCount} imported${failedCount ? ', ' + failedCount + ' failed' : ''})`;
        } else {
          this.elements.activityStepInfo.innerText = 'Ingest run failed';
        }
      }

      // Progress bar
      if (this.elements.activityProgressBar) {
        if (isRunning) {
          const pct = Math.min(95, Math.max(8, Math.round((processedCount / totalExpected) * 100)));
          this.elements.activityProgressBar.style.width = `${pct}%`;
          this.elements.activityProgressBar.className = 'bg-amber-500 h-full rounded-full transition-all duration-300';
        } else if (isCompleted) {
          this.elements.activityProgressBar.style.width = '100%';
          this.elements.activityProgressBar.className = failedCount > 0 ? 'bg-amber-500 h-full rounded-full' : 'bg-emerald-500 h-full rounded-full';
        } else {
          this.elements.activityProgressBar.style.width = '100%';
          this.elements.activityProgressBar.className = 'bg-red-500 h-full rounded-full';
        }
      }

      // Counts text
      if (this.elements.activityCounts) {
        this.elements.activityCounts.innerText = `${succeededCount} / ${totalExpected} completed`;
      }

      // GitHub Actions Link
      if (this.elements.activityGithubLink) {
        if (run.github_run_id) {
          const defaultRepo = (CONFIG.github?.owner && CONFIG.github?.repo) ? `${CONFIG.github.owner}/${CONFIG.github.repo}` : 'mnswamedia/trove';
          const rawRepo = localStorage.getItem(storage.ghRepoKey) || defaultRepo;
          this.elements.activityGithubLink.href = `https://github.com/${rawRepo}/actions/runs/${run.github_run_id}`;
          this.elements.activityGithubLink.classList.remove('hidden');
          this.elements.activityGithubLink.classList.add('inline-flex');
        } else {
          this.elements.activityGithubLink.classList.add('hidden');
        }
      }

      // Run ID Label
      if (this.elements.activityRunIdLabel) {
        this.elements.activityRunIdLabel.innerText = run.id || '';
      }

      // Items List
      if (this.elements.activityItemsList) {
        if (items.length === 0) {
          this.elements.activityItemsList.innerHTML = `
            <div class="p-3 text-center text-xs text-stone-brown dark:text-[#9aa4b2] bg-almond-cream/15 dark:bg-[#1a1e26] rounded-xl border border-dashed border-almond-cream dark:border-[#2b3240]">
              ${isRunning ? 'Waiting for songs to begin...' : 'No tracks recorded.'}
            </div>
          `;
        } else {
          let listHtml = '';
          items.forEach((it, idx) => {
            const trackNum = it.track_index || (idx + 1);
            const displayTitle = it.title || it.url || `Track #${trackNum}`;

            let badgeHtml = '';
            let rowBg = 'bg-almond-cream/15 border-almond-cream/60 dark:bg-[#1a1e26] dark:border-[#2b3240]';
            let metaHtml = '';

            if (it.status === 'succeeded') {
              badgeHtml = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 shrink-0"><i data-lucide="check" class="w-3 h-3"></i>Done</span>';
              rowBg = 'bg-emerald-50/40 border-emerald-200/50 dark:bg-emerald-950/20 dark:border-emerald-800/30';
              const parts = [];
              if (it.size_bytes) parts.push(formatBytes ? formatBytes(it.size_bytes) : `${Math.round(it.size_bytes / 1024)} KB`);
              if (it.duration_seconds) parts.push(formatDuration ? formatDuration(it.duration_seconds) : `${it.duration_seconds}s`);
              if (parts.length > 0) {
                metaHtml = `<span class="text-[10px] text-stone-brown/60 dark:text-[#8b95a5]">${parts.join(' • ')}</span>`;
              }
            } else if (it.status === 'skipped_archive') {
              badgeHtml = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300 shrink-0"><i data-lucide="check-check" class="w-3 h-3"></i>Cached</span>';
              rowBg = 'bg-blue-50/40 border-blue-200/50 dark:bg-blue-950/20 dark:border-blue-800/30';
              metaHtml = '<span class="text-[10px] text-blue-600 dark:text-blue-400">Already in library</span>';
            } else if (it.status === 'downloading') {
              badgeHtml = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 shrink-0"><i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i>Downloading</span>';
              rowBg = 'bg-amber-50/50 border-amber-300/60 dark:bg-amber-950/20 dark:border-amber-700/40';
              metaHtml = '<span class="text-[10px] text-amber-600 dark:text-amber-400">Downloading stream via WARP...</span>';
            } else if (it.status === 'failed') {
              badgeHtml = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300 shrink-0" title="${escapeHtml(it.error || 'Failed')}"><i data-lucide="alert-circle" class="w-3 h-3"></i>Failed</span>`;
              rowBg = 'bg-red-50/40 border-red-200/50 dark:bg-red-950/20 dark:border-red-800/30';
              if (it.error) {
                metaHtml = `<span class="text-[10px] text-red-600 dark:text-red-400 truncate" title="${escapeHtml(it.error)}">${escapeHtml(it.error)}</span>`;
              }
            } else {
              // Pending
              badgeHtml = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-gray-100 text-stone-brown dark:bg-[#202532] dark:text-[#9aa4b2] shrink-0"><i data-lucide="clock" class="w-3 h-3"></i>Queued</span>';
              metaHtml = '<span class="text-[10px] text-stone-brown/60 dark:text-[#758092]">Waiting in queue...</span>';
            }

            listHtml += `
              <div class="p-2.5 rounded-xl border text-xs flex items-center justify-between gap-2.5 transition ${rowBg}">
                <div class="flex items-center gap-2.5 min-w-0 flex-1">
                  <span class="font-mono text-[10px] text-stone-brown/60 dark:text-[#758092] shrink-0">#${trackNum}</span>
                  <div class="flex flex-col min-w-0 flex-1">
                    <span class="font-semibold text-black dark:text-[#f3f4f6] truncate" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</span>
                    ${metaHtml}
                  </div>
                </div>
                ${badgeHtml}
              </div>
            `;
          });
          this.elements.activityItemsList.innerHTML = listHtml;
        }
      }
    }
  };

  window.Trove.activity = ActivityManager;

  document.addEventListener('DOMContentLoaded', () => {
    ActivityManager.init();
  });
})();
