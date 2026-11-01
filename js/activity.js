/**
 * Trove Media Vault - Activity & Workflow Monitor
 * GitHub Actions polling engine, step logs renderer, and status indicators.
 */
(function() {
  window.Trove = window.Trove || {};

  const CONFIG = window.APP_CONFIG || {};
  const storage = CONFIG.storage || {};
  const { MotionAnim, formatDuration, escapeHtml } = window.Trove.utils || {};

  const ActivityManager = {
    elements: {},
    pollTimer: null,
    lastKnownRunId: null,
    lastKnownStatus: null,
    currentJobId: null,

    get isOpen() {
      return this.elements.modal && this.elements.modal.style.display === 'flex';
    },

    init() {
      this.elements = {
        modal: document.getElementById('activity-modal'),
        closeBtn: document.getElementById('close-activity-modal-btn'),
        backdrop: document.getElementById('activity-backdrop'),
        activityBtn: document.getElementById('activity-btn'),
        activityBtnIcon: document.getElementById('activity-btn-icon'),
        activityBtnLabel: document.getElementById('activity-btn-label'),
        mobileActivityBtn: document.getElementById('mobile-activity-btn'),
        mobileActivityDot: document.getElementById('mobile-activity-dot'),
        activityStatusPill: document.getElementById('activity-status-pill'),
        activityPulseDot: document.getElementById('activity-pulse-dot'),
        activityStepInfo: document.getElementById('activity-step-info'),
        activityTimeElapsed: document.getElementById('activity-time-elapsed'),
        activityProgressBar: document.getElementById('activity-progress-bar'),
        activityCounts: document.getElementById('activity-counts'),
        activityItemsList: document.getElementById('activity-items-list'),
        activityGithubLink: document.getElementById('activity-github-link'),
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
      if (this.elements.modal) {
        this.elements.modal.addEventListener('click', (e) => {
          const card = this.elements.modal.firstElementChild;
          if (card && !card.contains(e.target)) {
            this.close();
          }
        });
      }
      if (this.elements.backdrop) {
        this.elements.backdrop.addEventListener('click', () => this.close());
      }
    },

    open(jobId = null) {
      if (!this.elements.modal) return;
      if (jobId) {
        this.currentJobId = jobId;
      } else {
        this.currentJobId = sessionStorage.getItem('trove_current_job_id') || null;
      }
      this.elements.modal.style.display = 'flex';
      if (window.lucide) window.lucide.createIcons();
      this.poll(true);
      if (MotionAnim) MotionAnim.animateModalIn(this.elements.modal);
    },

    close() {
      if (!this.isOpen) return;
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
      if (MotionAnim) {
        MotionAnim.animateModalOut(this.elements.modal, () => {
          this.elements.modal.style.display = 'none';
        });
      } else {
        this.elements.modal.style.display = 'none';
      }
    },

    startPolling() {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.poll(true);
    },

    setButtonIdle() {
      if (!this.elements.activityBtn) return;
      this.elements.activityBtn.className = 'hidden sm:inline-flex w-8 h-8 items-center justify-center rounded-lg bg-white dark:bg-[#15181f] border border-khaki-beige dark:border-[#353c4d] text-jet-black dark:text-[#f3f4f6] hover:bg-almond-cream/40 dark:hover:bg-[#202532] transition shadow-sm select-none';
      this.elements.activityBtn.title = 'Ingestion Activity';
      if (this.elements.activityBtnIcon) {
        this.elements.activityBtnIcon.setAttribute('data-lucide', 'activity');
        this.elements.activityBtnIcon.className = 'w-4 h-4 text-stone-brown dark:text-[#c6ac8f]';
      }
      if (this.elements.activityBtnLabel) {
        this.elements.activityBtnLabel.className = 'sr-only';
        this.elements.activityBtnLabel.innerText = 'Activity';
      }
      if (window.lucide) window.lucide.createIcons();
    },

    showButton(label = 'Ingesting', isSpinning = true, variant = 'amber') {
      if (!this.elements.activityBtn) return;

      if (variant === 'green') {
        this.elements.activityBtn.className = 'hidden sm:inline-flex h-8 px-2 sm:px-2.5 items-center gap-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-900 dark:text-emerald-300 hover:bg-emerald-500/25 transition shadow-sm select-none';
        this.elements.activityBtn.title = 'Ingestion Completed - Click to view details';
        if (this.elements.activityBtnIcon) {
          this.elements.activityBtnIcon.setAttribute('data-lucide', 'check-circle-2');
          this.elements.activityBtnIcon.className = 'w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0';
        }
        if (this.elements.activityBtnLabel) {
          this.elements.activityBtnLabel.className = 'text-xs font-semibold font-mono hidden xs:inline';
          this.elements.activityBtnLabel.innerText = label;
        }
      } else if (variant === 'red') {
        this.elements.activityBtn.className = 'hidden sm:inline-flex h-8 px-2 sm:px-2.5 items-center gap-1.5 rounded-lg bg-red-500/15 border border-red-500/30 text-red-900 dark:text-red-300 hover:bg-red-500/25 transition shadow-sm select-none';
        this.elements.activityBtn.title = 'Ingestion Failed - Click to view details';
        if (this.elements.activityBtnIcon) {
          this.elements.activityBtnIcon.setAttribute('data-lucide', 'alert-circle');
          this.elements.activityBtnIcon.className = 'w-3.5 h-3.5 text-red-600 dark:text-red-400 shrink-0';
        }
        if (this.elements.activityBtnLabel) {
          this.elements.activityBtnLabel.className = 'text-xs font-semibold font-mono hidden xs:inline';
          this.elements.activityBtnLabel.innerText = label;
        }
      } else {
        // Active Ingesting (Amber)
        this.elements.activityBtn.className = 'hidden sm:inline-flex h-8 px-2 sm:px-2.5 items-center gap-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-900 dark:text-amber-300 hover:bg-amber-500/25 transition shadow-sm select-none';
        this.elements.activityBtn.title = 'Ingestion in progress - Click to view details';
        if (this.elements.activityBtnIcon) {
          this.elements.activityBtnIcon.setAttribute('data-lucide', 'loader-2');
          this.elements.activityBtnIcon.className = 'w-3.5 h-3.5 animate-spin text-amber-600 dark:text-amber-400 shrink-0';
        }
        if (this.elements.activityBtnLabel) {
          this.elements.activityBtnLabel.className = 'text-xs font-semibold font-mono hidden xs:inline';
          this.elements.activityBtnLabel.innerText = label;
        }
      }

      if (window.lucide) window.lucide.createIcons();
    },

    renderModal(run, steps = []) {
      if (!this.elements.modal) return;

      if (!run) {
        if (this.elements.activityStatusPill) {
          this.elements.activityStatusPill.innerText = 'Idle';
          this.elements.activityStatusPill.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-gray-100 text-stone-brown';
          if (this.elements.activityPulseDot) this.elements.activityPulseDot.className = 'w-2.5 h-2.5 rounded-full bg-stone-brown/40';
        }
        if (this.elements.mobileActivityDot) this.elements.mobileActivityDot.classList.add('hidden');
        if (this.elements.activityStepInfo) this.elements.activityStepInfo.innerText = 'No ingestion runs recorded yet.';
        if (this.elements.activityTimeElapsed) this.elements.activityTimeElapsed.innerText = '00:00';
        if (this.elements.activityProgressBar) {
          this.elements.activityProgressBar.style.width = '0%';
          this.elements.activityProgressBar.className = 'bg-jet-black h-full rounded-full transition-all duration-300';
        }
        if (this.elements.activityCounts) this.elements.activityCounts.innerText = 'Ready to import';
        if (this.elements.activityItemsList) {
          this.elements.activityItemsList.innerHTML = `
            <div class="p-4 text-center text-xs text-stone-brown dark:text-[#9aa4b2] bg-almond-cream/15 dark:bg-[#1a1e26] rounded-xl border border-dashed border-almond-cream dark:border-[#2b3240] flex flex-col items-center gap-2">
              <i data-lucide="info" class="w-4 h-4 text-stone-brown/60 dark:text-[#758092]"></i>
              <span>No active downloads. Click the Import button (download icon) in the header to import songs from YouTube.</span>
            </div>
          `;
        }
        if (window.lucide) window.lucide.createIcons();
        return;
      }

      if (this.elements.activityGithubLink && run.html_url) {
        this.elements.activityGithubLink.href = run.html_url;
      }

      const isRunning = run.status === 'in_progress' || run.status === 'queued';
      const isSuccess = run.status === 'completed' && run.conclusion === 'success';

      const startTime = new Date(run.run_started_at || run.created_at).getTime();
      const endTime = isRunning ? Date.now() : new Date(run.updated_at || run.completed_at || Date.now()).getTime();
      const elapsedSec = Math.max(0, Math.floor((endTime - startTime) / 1000));

      if (this.elements.activityTimeElapsed) {
        this.elements.activityTimeElapsed.innerText = formatDuration(elapsedSec);
      }

      const visibleSteps = steps.filter(s => s.name !== 'Set up job' && s.name !== 'Complete job');
      const totalSteps = Math.max(1, visibleSteps.length);
      const completedStepsCount = visibleSteps.filter(s => s.status === 'completed' && s.conclusion === 'success').length;
      const activeStep = visibleSteps.find(s => s.status === 'in_progress');

      if (isRunning) {
        const pct = Math.min(95, Math.round((completedStepsCount / totalSteps) * 100));
        if (this.elements.activityProgressBar) {
          this.elements.activityProgressBar.style.width = `${Math.max(10, pct)}%`;
          this.elements.activityProgressBar.className = 'bg-amber-500 h-full rounded-full transition-all duration-300';
        }
        if (this.elements.activityStatusPill) {
          this.elements.activityStatusPill.innerText = run.status === 'queued' ? 'Queued' : 'In Progress';
          this.elements.activityStatusPill.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800';
          if (this.elements.activityPulseDot) this.elements.activityPulseDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse';
          if (this.elements.mobileActivityDot) this.elements.mobileActivityDot.classList.remove('hidden');
        }
        if (this.elements.activityStepInfo) {
          this.elements.activityStepInfo.innerText = activeStep ? `Step: ${activeStep.name}` : (run.status === 'queued' ? 'Runner queued in GitHub Actions...' : 'Running workflow...');
        }
        if (this.elements.activityCounts) {
          this.elements.activityCounts.innerText = `Step ${completedStepsCount + (activeStep ? 1 : 0)} of ${totalSteps}`;
        }
      } else if (isSuccess) {
        if (this.elements.activityProgressBar) {
          this.elements.activityProgressBar.style.width = '100%';
          this.elements.activityProgressBar.className = 'bg-emerald-500 h-full rounded-full transition-all duration-300';
        }
        if (this.elements.activityStatusPill) {
          this.elements.activityStatusPill.innerText = 'Completed';
          this.elements.activityStatusPill.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-800';
          if (this.elements.activityPulseDot) this.elements.activityPulseDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500';
          if (this.elements.mobileActivityDot) this.elements.mobileActivityDot.classList.add('hidden');
        }
        if (this.elements.activityStepInfo) {
          this.elements.activityStepInfo.innerText = `Finished successfully in ${formatDuration(elapsedSec)}`;
        }
        if (this.elements.activityCounts) {
          this.elements.activityCounts.innerText = `All ${totalSteps} steps completed`;
        }
      } else {
        if (this.elements.activityProgressBar) {
          this.elements.activityProgressBar.style.width = '100%';
          this.elements.activityProgressBar.className = 'bg-red-500 h-full rounded-full transition-all duration-300';
        }
        if (this.elements.activityStatusPill) {
          this.elements.activityStatusPill.innerText = run.conclusion ? run.conclusion.toUpperCase() : 'FAILED';
          this.elements.activityStatusPill.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-red-100 text-red-800';
          if (this.elements.activityPulseDot) this.elements.activityPulseDot.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
          if (this.elements.mobileActivityDot) this.elements.mobileActivityDot.classList.add('hidden');
        }
        if (this.elements.activityStepInfo) {
          this.elements.activityStepInfo.innerText = `Run ended with: ${run.conclusion || 'failure'}`;
        }
        if (this.elements.activityCounts) {
          this.elements.activityCounts.innerText = 'Check terminal logs for errors';
        }
      }

      if (this.elements.activityItemsList) {
        if (visibleSteps.length === 0) {
          this.elements.activityItemsList.innerHTML = `
            <div class="p-3 text-center text-xs text-stone-brown dark:text-[#9aa4b2] bg-almond-cream/15 dark:bg-[#1a1e26] rounded-xl border border-dashed border-almond-cream dark:border-[#2b3240]">
              ${isRunning ? 'Connecting to runner...' : 'Workflow completed.'}
            </div>
          `;
        } else {
          let listHtml = '';
          visibleSteps.forEach((st, idx) => {
            let badge = '';
            let rowBg = 'bg-almond-cream/15 border-almond-cream/60 dark:bg-[#1a1e26] dark:border-[#2b3240]';

            if (st.status === 'completed' && st.conclusion === 'success') {
              badge = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 shrink-0"><i data-lucide="check" class="w-3 h-3"></i>Done</span>';
              rowBg = 'bg-emerald-50/50 border-emerald-200/60 dark:bg-emerald-950/30 dark:border-emerald-800/40';
            } else if (st.status === 'in_progress') {
              badge = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 shrink-0"><i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i>In Progress</span>';
              rowBg = 'bg-amber-50/80 border-amber-300 dark:bg-amber-950/30 dark:border-amber-700/50';
            } else if (st.conclusion === 'failure') {
              badge = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300 shrink-0"><i data-lucide="x" class="w-3 h-3"></i>Failed</span>';
              rowBg = 'bg-red-50/60 border-red-200 dark:bg-red-950/30 dark:border-red-800/40';
            } else {
              badge = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-gray-100 text-stone-brown dark:bg-[#202532] dark:text-[#9aa4b2] shrink-0"><i data-lucide="clock" class="w-3 h-3"></i>Queued</span>';
            }

            listHtml += `
              <div class="p-2.5 rounded-xl border text-xs flex items-center justify-between gap-2.5 transition ${rowBg}">
                <div class="flex items-center gap-2 min-w-0 flex-1">
                  <span class="font-mono text-[10px] text-stone-brown/60 dark:text-[#758092] shrink-0">#${idx + 1}</span>
                  <span class="font-semibold text-black dark:text-[#f3f4f6] truncate" title="${escapeHtml(st.name)}">${escapeHtml(st.name)}</span>
                </div>
                ${badge}
              </div>
            `;
          });
          this.elements.activityItemsList.innerHTML = listHtml;
        }
      }

      if (window.lucide) window.lucide.createIcons();
    },

    renderWorkerProgress(job, events = []) {
      if (!job) return false;

      const isRunning = job.status === 'in_progress' || job.status === 'queued';
      const isSuccess = job.status === 'completed';

      const startTime = job.created_at || Date.now();
      const endTime = isRunning ? Date.now() : (job.updated_at || Date.now());
      const elapsedSec = Math.max(0, Math.floor((endTime - startTime) / 1000));

      if (this.elements.activityTimeElapsed) {
        this.elements.activityTimeElapsed.innerText = formatDuration(elapsedSec);
      }

      const songEvents = events.filter(e => e.status !== 'queued' && (e.song_id || e.url || e.title));
      const displayEvents = songEvents.length > 0 ? songEvents : events;

      const totalExpected = Math.max(job.targets_count || 1, displayEvents.length || 1);
      const succeededCount = displayEvents.filter(e => e.status === 'succeeded').length;
      const failedCount = displayEvents.filter(e => e.status === 'failed').length;
      const activeEvent = displayEvents.find(e => e.status === 'downloading');

      if (isRunning) {
        const pct = Math.min(95, Math.max(10, Math.round(((succeededCount + failedCount) / totalExpected) * 100)));
        if (this.elements.activityProgressBar) {
          this.elements.activityProgressBar.style.width = `${pct}%`;
          this.elements.activityProgressBar.className = 'bg-amber-500 h-full rounded-full transition-all duration-300';
        }
        if (this.elements.activityStatusPill) {
          this.elements.activityStatusPill.innerText = job.status === 'queued' ? 'Queued' : 'In Progress';
          this.elements.activityStatusPill.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300';
          if (this.elements.activityPulseDot) this.elements.activityPulseDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse';
          if (this.elements.mobileActivityDot) this.elements.mobileActivityDot.classList.remove('hidden');
        }
        if (this.elements.activityStepInfo) {
          this.elements.activityStepInfo.innerText = activeEvent ? `Downloading: ${activeEvent.title || activeEvent.url}` : (job.status === 'queued' ? 'Runner queued in GitHub Actions...' : `Processing ${totalExpected} target(s)...`);
        }
        if (this.elements.activityCounts) {
          this.elements.activityCounts.innerText = `${succeededCount + failedCount} of ${totalExpected} processed`;
        }
      } else if (isSuccess) {
        if (this.elements.activityProgressBar) {
          this.elements.activityProgressBar.style.width = '100%';
          this.elements.activityProgressBar.className = failedCount > 0 ? 'bg-amber-500 h-full rounded-full' : 'bg-emerald-500 h-full rounded-full transition-all duration-300';
        }
        if (this.elements.activityStatusPill) {
          this.elements.activityStatusPill.innerText = failedCount > 0 ? 'Completed with errors' : 'Completed';
          this.elements.activityStatusPill.className = failedCount > 0 
            ? 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
            : 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300';
          if (this.elements.activityPulseDot) this.elements.activityPulseDot.className = failedCount > 0 ? 'w-2.5 h-2.5 rounded-full bg-amber-500' : 'w-2.5 h-2.5 rounded-full bg-emerald-500';
          if (this.elements.mobileActivityDot) this.elements.mobileActivityDot.classList.add('hidden');
        }
        if (this.elements.activityStepInfo) {
          this.elements.activityStepInfo.innerText = `Finished in ${formatDuration(elapsedSec)} (${succeededCount} added${failedCount ? ', ' + failedCount + ' failed' : ''})`;
        }
        if (this.elements.activityCounts) {
          this.elements.activityCounts.innerText = `${succeededCount}/${totalExpected} succeeded`;
        }
      } else {
        if (this.elements.activityProgressBar) {
          this.elements.activityProgressBar.style.width = '100%';
          this.elements.activityProgressBar.className = 'bg-red-500 h-full rounded-full';
        }
        if (this.elements.activityStatusPill) {
          this.elements.activityStatusPill.innerText = 'Failed';
          this.elements.activityStatusPill.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-red-100 text-red-800';
          if (this.elements.activityPulseDot) this.elements.activityPulseDot.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
          if (this.elements.mobileActivityDot) this.elements.mobileActivityDot.classList.add('hidden');
        }
        if (this.elements.activityStepInfo) {
          this.elements.activityStepInfo.innerText = 'Ingest job failed';
        }
      }

      if (this.elements.activityItemsList) {
        if (displayEvents.length === 0) {
          this.elements.activityItemsList.innerHTML = `
            <div class="p-3 text-center text-xs text-stone-brown dark:text-[#9aa4b2] bg-almond-cream/15 dark:bg-[#1a1e26] rounded-xl border border-dashed border-almond-cream dark:border-[#2b3240]">
              ${isRunning ? 'Waiting for song events from runner...' : 'No song events recorded.'}
            </div>
          `;
        } else {
          let listHtml = '';
          displayEvents.forEach((ev, idx) => {
            let badge = '';
            let rowBg = 'bg-almond-cream/15 border-almond-cream/60 dark:bg-[#1a1e26] dark:border-[#2b3240]';
            const displayTitle = ev.title || ev.url || `Item #${idx + 1}`;

            if (ev.status === 'succeeded' || ev.status === 'completed') {
              badge = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 shrink-0"><i data-lucide="check" class="w-3 h-3"></i>Done</span>';
              rowBg = 'bg-emerald-50/50 border-emerald-200/60 dark:bg-emerald-950/30 dark:border-emerald-800/40';
            } else if (ev.status === 'downloading' || ev.status === 'in_progress') {
              badge = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 shrink-0"><i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i>Downloading</span>';
              rowBg = 'bg-amber-50/80 border-amber-300 dark:bg-amber-950/30 dark:border-amber-700/50';
            } else if (ev.status === 'failed') {
              badge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300 shrink-0" title="${escapeHtml(ev.error || 'Failed')}"><i data-lucide="alert-circle" class="w-3 h-3"></i>Failed</span>`;
              rowBg = 'bg-red-50/60 border-red-200 dark:bg-red-950/30 dark:border-red-800/40';
            } else {
              badge = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-gray-100 text-stone-brown dark:bg-[#202532] dark:text-[#9aa4b2] shrink-0"><i data-lucide="clock" class="w-3 h-3"></i>Queued</span>';
            }

            listHtml += `
              <div class="p-2.5 rounded-xl border text-xs flex items-center justify-between gap-2.5 transition ${rowBg}">
                <div class="flex items-center gap-2 min-w-0 flex-1">
                  <span class="font-mono text-[10px] text-stone-brown/60 dark:text-[#758092] shrink-0">#${idx + 1}</span>
                  <div class="flex flex-col min-w-0">
                    <span class="font-semibold text-black dark:text-[#f3f4f6] truncate" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</span>
                    ${ev.error ? `<span class="text-[10px] text-red-600 dark:text-red-400 truncate">${escapeHtml(ev.error)}</span>` : ''}
                  </div>
                </div>
                ${badge}
              </div>
            `;
          });
          this.elements.activityItemsList.innerHTML = listHtml;
        }
      }

      if (window.lucide) window.lucide.createIcons();
      return true;
    },

    async poll(isManual = false) {
      if (!this.elements.modal || this.elements.modal.style.display !== 'flex') {
        if (this.pollTimer) {
          clearTimeout(this.pollTimer);
          this.pollTimer = null;
        }
        return;
      }

      // 1. Try Cloudflare Worker Telemetry first (Live Song-by-Song updates every 2s)
      const workerUrl = CONFIG.getWorkerEndpoint ? CONFIG.getWorkerEndpoint('/ingest') : null;
      const workerToken = localStorage.getItem(storage.workerTokenKey) || '';

      if (workerUrl) {
        try {
          const reqJobId = this.currentJobId || sessionStorage.getItem('trove_current_job_id') || '';
          const fetchUrl = `${workerUrl.replace(/\/+$/, '')}/progress${reqJobId ? '?job_id=' + encodeURIComponent(reqJobId) : ''}`;
          const headers = {};
          if (workerToken) {
            headers['Authorization'] = `Bearer ${workerToken}`;
            headers['X-API-Key'] = workerToken;
          }
          const wRes = await fetch(fetchUrl, { headers, cache: 'no-store' });
          if (wRes.ok) {
            const wData = await wRes.json();
            if (wData.success && wData.job) {
              const isHandled = this.renderWorkerProgress(wData.job, wData.events || []);
              if (isHandled) {
                const isRunning = wData.job.status === 'in_progress' || wData.job.status === 'queued';
                if (isRunning) {
                  this.lastKnownStatus = 'in_progress';
                  this.showButton('Ingesting...', true, 'amber');
                  if (this.elements.modal && this.elements.modal.style.display === 'flex') {
                    if (this.pollTimer) clearTimeout(this.pollTimer);
                    this.pollTimer = setTimeout(() => this.poll(false), 2000); // 2-second live worker polling
                  }
                  return;
                } else {
                  if (this.lastKnownStatus === 'in_progress') {
                    this.lastKnownStatus = 'completed';
                    const hasFailures = (wData.events || []).some(e => e.status === 'failed');
                    this.showButton(hasFailures ? 'Completed (warnings)' : 'Done', false, hasFailures ? 'amber' : 'green');
                    if (window.Trove.explorer) {
                      window.Trove.explorer.loadRepository(true);
                    }
                    setTimeout(() => this.setButtonIdle(), 7000);
                  }
                  if (this.elements.modal && this.elements.modal.style.display === 'flex') {
                    if (this.pollTimer) clearTimeout(this.pollTimer);
                    this.pollTimer = setTimeout(() => this.poll(false), 5000);
                  }
                  return;
                }
              }
            }
          }
        } catch (wErr) {
          console.warn('Worker telemetry poll note:', wErr);
        }
      }

      const ghToken = localStorage.getItem(storage.ghTokenKey) || '';
      const defaultRepo = (CONFIG.github?.owner && CONFIG.github?.repo) ? `${CONFIG.github.owner}/${CONFIG.github.repo}` : 'mnswa/trove';
      const rawRepo = localStorage.getItem(storage.ghRepoKey) || defaultRepo;
      const [owner, repoName] = rawRepo.split('/').map(s => s.trim());
      const workflowFile = CONFIG.github?.workflowFile || 'ingest.yml';

      let nextDelay = 5000;

      try {
        const runsUrl = `https://api.github.com/repos/${owner}/${repoName}/actions/workflows/${workflowFile}/runs?per_page=5&_t=${Date.now()}`;
        const headers = {
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        };
        if (ghToken) headers['Authorization'] = `Bearer ${ghToken}`;

        const res = await fetch(runsUrl, { headers, cache: 'no-store' });

        if (res.ok) {
          const data = await res.json();
          const runs = data.workflow_runs || [];

          if (runs.length > 0) {
            const latestRun = runs[0];
            const isRunning = latestRun.status === 'in_progress' || latestRun.status === 'queued';

            let steps = [];
            try {
              const jobsUrl = `https://api.github.com/repos/${owner}/${repoName}/actions/runs/${latestRun.id}/jobs?_t=${Date.now()}`;
              const jobsRes = await fetch(jobsUrl, { headers, cache: 'no-store' });
              if (jobsRes.ok) {
                const jobsData = await jobsRes.json();
                const job = (jobsData.jobs || [])[0];
                if (job && Array.isArray(job.steps)) {
                  steps = job.steps;
                }
              }
            } catch (_) {}

            this.renderModal(latestRun, steps);

            if (isRunning) {
              nextDelay = 3000;
              this.lastKnownRunId = latestRun.id;
              this.lastKnownStatus = 'in_progress';

              const activeStep = steps.find(s => s.status === 'in_progress');
              const btnLabel = activeStep ? activeStep.name.replace(/^Run Ingest Script$/, 'Ingesting').substring(0, 15) : 'Ingesting...';
              this.showButton(btnLabel, true, 'amber');
            } else {
              if (this.lastKnownStatus === 'in_progress' && this.lastKnownRunId === latestRun.id) {
                this.lastKnownStatus = 'completed';
                this.showButton(latestRun.conclusion === 'success' ? 'Done' : 'Failed', false, latestRun.conclusion === 'success' ? 'green' : 'red');
                if (latestRun.conclusion === 'success' && window.Trove.explorer) {
                  window.Trove.explorer.loadRepository(true);
                }
                setTimeout(() => {
                  this.setButtonIdle();
                }, 7000);
              } else {
                this.setButtonIdle();
              }
              nextDelay = 5000;
            }
          } else {
            this.renderModal(null);
            this.setButtonIdle();
            nextDelay = 6000;
          }
        } else {
          if (this.elements.modal && this.elements.modal.style.display === 'flex') {
            if (res.status === 401 || res.status === 403) {
              if (this.elements.activityStepInfo) this.elements.activityStepInfo.innerText = 'GitHub authentication error. Check GitHub Token.';
            } else if (res.status === 404) {
              if (this.elements.activityStepInfo) this.elements.activityStepInfo.innerText = `Workflow '${workflowFile}' not found in ${owner}/${repoName}.`;
            }
          }
          this.setButtonIdle();
          nextDelay = 6000;
        }
      } catch (err) {
        console.warn('Error polling GitHub Actions API:', err);
        nextDelay = 6000;
      }

      if (this.elements.modal && this.elements.modal.style.display === 'flex') {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = setTimeout(() => this.poll(false), nextDelay);
      } else {
        if (this.pollTimer) {
          clearTimeout(this.pollTimer);
          this.pollTimer = null;
        }
      }
    }
  };

  // Export
  window.Trove.activity = ActivityManager;

  // Backward compatibility aliases
  window.showActivityModal = () => ActivityManager.open();
  window.hideActivityModal = () => ActivityManager.close();
  window.pollActiveIngestion = (manual) => ActivityManager.poll(manual);
  window.startActiveIngestionPolling = () => ActivityManager.startPolling();
})();

