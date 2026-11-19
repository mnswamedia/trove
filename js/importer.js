/**
 * Trove Media Vault - YouTube Importer & GitHub Actions Ingest Dispatcher
 * URL parsing, batch .txt ingestion, and workflow dispatch.
 */
(function() {
  window.Trove = window.Trove || {};

  const CONFIG = window.APP_CONFIG || {};
  const repo = CONFIG.repo || {};
  const storage = CONFIG.storage || {};
  const { MotionAnim, cleanAllInputUrls, showToast } = window.Trove.utils || {};

  const ImportManager = {
    elements: {},

    get isOpen() {
      return this.elements.modal && this.elements.modal.style.display === 'flex';
    },

    init() {
      this.elements = {
        modal: document.getElementById('import-modal'),
        backdrop: document.getElementById('import-backdrop'),
        openBtn: document.getElementById('import-btn'),
        mobileOpenBtn: document.getElementById('mobile-import-btn'),
        closeBtn: document.getElementById('close-import-modal-btn'),
        cancelBtn: document.getElementById('cancel-import-btn'),
        form: document.getElementById('import-form'),
        urlsInput: document.getElementById('import-urls-input'),
        fileInput: document.getElementById('import-file-input'),
        fileDropzone: document.getElementById('import-file-dropzone'),
        filenameDisplay: document.getElementById('import-filename-display'),
        clearFileBtn: document.getElementById('import-clear-file-btn'),
        progressBox: document.getElementById('import-progress-box'),
        statusText: document.getElementById('import-status-text'),
        statusSubtext: document.getElementById('import-status-subtext'),
        errorMsg: document.getElementById('import-error-msg'),
        startBtn: document.getElementById('start-import-btn'),
        mobileNavMenu: document.getElementById('mobile-nav-menu')
      };

      this.setupEventListeners();
    },

    open(prefillUrl = '') {
      const state = window.Trove.state || {};
      if (!state.token) {
        if (window.Trove.settings) {
          window.Trove.settings.open('Please connect with your Hugging Face Token first.');
        }
        return;
      }

      if (!this.elements.modal) return;
      this.elements.modal.style.display = 'flex';
      if (this.elements.progressBox) this.elements.progressBox.classList.add('hidden');
      if (this.elements.errorMsg) this.elements.errorMsg.classList.add('hidden');
      if (this.elements.startBtn) {
        this.elements.startBtn.disabled = false;
        this.elements.startBtn.classList.remove('opacity-50', 'opacity-75', 'pointer-events-none');
        this.elements.startBtn.innerHTML = '<i data-lucide="download" class="w-3.5 h-3.5"></i><span>Start Download</span>';
      }

      if (prefillUrl && this.elements.urlsInput) {
        const cleanFn = window.Trove.utils?.cleanAllInputUrls || cleanAllInputUrls;
        const cleaned = cleanFn ? cleanFn(prefillUrl) : prefillUrl;
        this.elements.urlsInput.value = cleaned;
      }

      setTimeout(() => {
        if (this.elements.urlsInput) this.elements.urlsInput.focus();
      }, 50);

      if (window.lucide) window.lucide.createIcons();
      if (MotionAnim) MotionAnim.animateSheetIn(this.elements.modal);
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

    setFormat(format = 'm4a') {
      const radio = document.querySelector(`input[name="import-format"][value="${format}"]`);
      if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
      }
    },

    hasSharePayload() {
      try {
        const search = window.location.search;
        if (!search) return false;
        const params = new URLSearchParams(search);
        return Boolean(params.get('title') || params.get('text') || params.get('url'));
      } catch (_) {
        return false;
      }
    },

    returnToSource() {
      try {
        if (window.history.length > 1) {
          window.history.back();
        }
      } catch (_) {}
      try {
        window.close();
      } catch (_) {}
    },

    showQuickShareHud({ title, targetUrls }) {
      let hud = document.getElementById('trove-share-hud');
      if (!hud) {
        hud = document.createElement('div');
        hud.id = 'trove-share-hud';
        document.body.appendChild(hud);
      }

      hud.className = 'fixed inset-0 z-[250] flex items-end sm:items-center justify-center p-4 bg-black/75 backdrop-blur-md transition-opacity duration-200 select-none';
      hud.innerHTML = `
        <div class="w-full max-w-sm bg-jet-black dark:bg-[#15181f] border border-stone-brown/40 dark:border-[#353c4d] rounded-2xl p-4 sm:p-5 shadow-2xl flex flex-col gap-3.5 text-white">
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0 shadow-sm">
                <i data-lucide="zap" class="w-5 h-5"></i>
              </div>
              <div class="min-w-0">
                <div class="text-[10px] font-semibold tracking-wider uppercase text-amber-400 flex items-center gap-1.5">
                  <span>Quick Ingest</span>
                  <span class="w-1 h-1 rounded-full bg-amber-400/60"></span>
                  <span class="text-stone-300 dark:text-[#9aa4b2]">Audio (.m4a)</span>
                </div>
                <h3 id="trove-share-hud-title" class="text-sm font-bold text-white truncate mt-0.5"></h3>
              </div>
            </div>
            <button type="button" id="trove-share-hud-close" class="p-1.5 text-stone-400 hover:text-white rounded-lg transition" title="Dismiss">
              <i data-lucide="x" class="w-4 h-4"></i>
            </button>
          </div>

          <div id="trove-share-hud-status" class="flex items-center gap-3 p-3 rounded-xl bg-white/5 border border-white/10 text-xs">
            <div id="trove-share-hud-icon" class="w-4 h-4 shrink-0 flex items-center justify-center">
              <i data-lucide="loader-2" class="w-4 h-4 text-amber-400 animate-spin"></i>
            </div>
            <span id="trove-share-hud-msg" class="text-stone-200 font-medium truncate min-w-0">Dispatching to vault runner...</span>
          </div>

          <div id="trove-share-hud-actions" class="flex flex-col gap-2 pt-0.5">
            <button type="button" id="trove-share-hud-return" class="w-full py-2.5 px-3 bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs rounded-xl shadow-md transition flex items-center justify-center gap-1.5 active:scale-95">
              <i data-lucide="arrow-left" class="w-3.5 h-3.5"></i>
              <span id="trove-share-hud-return-text">Back to YouTube</span>
            </button>
            <button type="button" id="trove-share-hud-open" class="w-full py-2 px-3 text-stone-400 hover:text-stone-200 font-medium text-xs rounded-xl transition text-center active:scale-95">
              Stay & Browse Trove Vault
            </button>
            <p class="text-[10px] text-stone-400/80 text-center select-none">Swipe back from screen edge anytime to resume video</p>
          </div>
        </div>
      `;

      const titleEl = hud.querySelector('#trove-share-hud-title');
      if (titleEl) titleEl.innerText = title || 'Shared YouTube Track';

      if (window.lucide && typeof window.lucide.createIcons === 'function') {
        window.lucide.createIcons();
      }

      const dismissHud = (openVault = false) => {
        hud.classList.add('opacity-0', 'pointer-events-none');
        setTimeout(() => {
          try { hud.remove(); } catch (_) {}
        }, 200);

        if (openVault && window.Trove.explorer && !window.Trove.state?.allItems?.length) {
          window.Trove.explorer.loadRepository(false);
        }
      };

      hud.querySelector('#trove-share-hud-close')?.addEventListener('click', () => dismissHud(false));
      hud.querySelector('#trove-share-hud-open')?.addEventListener('click', () => dismissHud(true));
      hud.querySelector('#trove-share-hud-return')?.addEventListener('click', () => {
        this.returnToSource();
        const msgEl = hud.querySelector('#trove-share-hud-msg');
        if (msgEl) msgEl.innerText = 'Swipe back from screen edge to resume video';
      });

      return {
        setStatus: (text, type = 'loading') => {
          const msgEl = hud.querySelector('#trove-share-hud-msg');
          const iconEl = hud.querySelector('#trove-share-hud-icon');
          if (msgEl) msgEl.innerText = text;
          if (iconEl) {
            if (type === 'loading') {
              iconEl.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 text-amber-400 animate-spin"></i>';
            } else if (type === 'success') {
              iconEl.innerHTML = '<i data-lucide="check-circle-2" class="w-4 h-4 text-emerald-400"></i>';
            } else if (type === 'error') {
              iconEl.innerHTML = '<i data-lucide="alert-circle" class="w-4 h-4 text-rose-400"></i>';
            }
            if (window.lucide && typeof window.lucide.createIcons === 'function') {
              window.lucide.createIcons();
            }
          }
        },
        setError: (errText) => {
          const msgEl = hud.querySelector('#trove-share-hud-msg');
          const iconEl = hud.querySelector('#trove-share-hud-icon');
          if (msgEl) msgEl.innerText = errText;
          if (iconEl) {
            iconEl.innerHTML = '<i data-lucide="alert-circle" class="w-4 h-4 text-rose-400"></i>';
          }
          const returnBtn = hud.querySelector('#trove-share-hud-return');
          if (returnBtn) {
            returnBtn.innerHTML = '<i data-lucide="settings" class="w-3.5 h-3.5"></i><span>Open Settings</span>';
            returnBtn.onclick = () => {
              dismissHud(true);
              if (window.Trove.settings) window.Trove.settings.open(errText);
            };
          }
          if (window.lucide && typeof window.lucide.createIcons === 'function') {
            window.lucide.createIcons();
          }
        }
      };
    },

    async dispatchIngest({ targets, format = 'm4a' }) {
      const state = window.Trove.state || {};
      const ghToken = localStorage.getItem(storage.ghTokenKey) || '';
      if (!ghToken) {
        throw new Error('GitHub Personal Access Token is required in Settings.');
      }

      const defaultRepo = (CONFIG.github?.owner && CONFIG.github?.repo) ? `${CONFIG.github.owner}/${CONFIG.github.repo}` : 'mnswamedia/trove';
      const rawRepo = localStorage.getItem(storage.ghRepoKey) || defaultRepo;
      const repoParts = rawRepo.split('/').map(s => s.trim());
      if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
        throw new Error('Invalid GitHub repository in Settings (expected "owner/repo").');
      }
      const [owner, repoName] = repoParts;
      const workflowFile = CONFIG.github?.workflowFile || 'ingest.yml';

      const workerUrl = CONFIG.getWorkerEndpoint ? CONFIG.getWorkerEndpoint('/ingest') : null;
      const workerToken = CONFIG.getWorkerToken ? CONFIG.getWorkerToken() : (localStorage.getItem(storage.workerTokenKey) || '').trim();

      if (workerUrl) {
        if (!workerToken) {
          throw new Error('Worker API Secret is required in Settings when Cloudflare Worker URL is configured.');
        }
        const headers = CONFIG.getWorkerAuthHeaders
          ? CONFIG.getWorkerAuthHeaders({ 'Content-Type': 'application/json' })
          : {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${workerToken}`,
              'X-API-Key': workerToken
            };

        const response = await fetch(`${workerUrl.replace(/\/+$/, '')}/dispatch`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            targets,
            format,
            bucket_id: repo.id,
            hf_token: state.token || '',
            gh_token: ghToken,
            owner: owner,
            repo: repoName,
            ref: CONFIG.github?.ref || 'main',
            workflow: workflowFile
          })
        });

        if (!response.ok) {
          let errDetail = `Worker request failed with status ${response.status}`;
          try {
            const errData = await response.json();
            errDetail = errData.error || errDetail;
          } catch (_) {}
          throw new Error(errDetail);
        }

        const resData = await response.json();
        const currentJobId = resData.run_id || resData.job_id;
        if (currentJobId) {
          sessionStorage.setItem('trove_current_run_id', currentJobId);
          sessionStorage.setItem('trove_current_job_id', currentJobId);
        }
        return { success: true, jobId: currentJobId, via: 'worker' };
      } else {
        // Direct GitHub API
        const dispatchUrl = `https://api.github.com/repos/${owner}/${repoName}/actions/workflows/${workflowFile}/dispatches`;
        const response = await fetch(dispatchUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ghToken}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            ref: CONFIG.github?.ref || 'main',
            inputs: {
              targets,
              format,
              bucket_id: repo.id,
              hf_token: state.token || ''
            }
          })
        });

        if (!response.ok) {
          let errDetail = `GitHub API request failed with status ${response.status}`;
          try {
            const errData = await response.json();
            errDetail = errData.message || errDetail;
          } catch (_) {}
          if (response.status === 404) {
            errDetail = `Workflow '${workflowFile}' not found in repository ${owner}/${repoName}.`;
          } else if (response.status === 401 || response.status === 403) {
            errDetail = `GitHub authentication failed. Check your Personal Access Token scopes.`;
          }
          throw new Error(errDetail);
        }
        return { success: true, via: 'github' };
      }
    },

    async handleShareTarget() {
      try {
        const search = window.location.search;
        if (!search) return false;

        const params = new URLSearchParams(search);
        const sharedTitle = (params.get('title') || '').trim();
        const sharedText = (params.get('text') || '').trim();
        const sharedUrl = (params.get('url') || '').trim();

        // Check if any share param is present
        if (!sharedTitle && !sharedText && !sharedUrl) {
          return false;
        }

        // Clean query parameters from URL bar immediately so refreshing doesn't re-trigger
        const cleanUrl = window.location.pathname + window.location.hash;
        window.history.replaceState({}, document.title, cleanUrl);

        const extractFn = window.Trove.utils?.extractYouTubeUrls;
        const urls = extractFn ? extractFn([sharedUrl, sharedText, sharedTitle]) : [];

        if (urls.length === 0) {
          // If no YouTube links found but text or URL was shared, open importer with fallback
          const fallback = (sharedUrl || sharedText).trim();
          if (fallback) {
            this.open(fallback);
            this.setFormat('m4a');
          }
          return true;
        }

        const targetUrls = urls.join('\n');
        const songName = sharedTitle || (urls.length === 1 ? 'YouTube Track' : `${urls.length} YouTube Tracks`);

        // Show instant Quick Ingest HUD without heavy modals or intro transitions
        const hud = this.showQuickShareHud({ title: songName, targetUrls });

        const state = window.Trove.state || {};
        if (!state.token) {
          hud.setError('Please connect Hugging Face Token in Settings first.');
          return true;
        }

        // Dispatch ingestion immediately (0ms wait, no modal transitions)
        try {
          await this.dispatchIngest({ targets: targetUrls, format: 'm4a' });
          hud.setStatus('Queued for download! Sent to runner.', 'success');
        } catch (dispatchErr) {
          hud.setError(dispatchErr.message || 'Dispatch failed. Check Settings.');
        }

        return true;
      } catch (err) {
        console.error('Error handling share target:', err);
        return false;
      }
    },

    showError(msg) {
      if (this.elements.errorMsg) {
        this.elements.errorMsg.innerText = msg;
        this.elements.errorMsg.classList.remove('hidden');
      }
      if (this.elements.progressBox) this.elements.progressBox.classList.add('hidden');
    },

    clearSelectedFile() {
      if (this.elements.fileInput) this.elements.fileInput.value = '';
      if (this.elements.filenameDisplay) {
        this.elements.filenameDisplay.innerText = 'Select a .txt file (one link per line)';
      }
      if (this.elements.clearFileBtn) this.elements.clearFileBtn.classList.add('hidden');
    },

    async handleSubmit(e) {
      if (e) e.preventDefault();

      const rawUrls = this.elements.urlsInput ? this.elements.urlsInput.value.trim() : '';
      const cleanFn = window.Trove.utils?.cleanAllInputUrls || cleanAllInputUrls;
      const urlsText = cleanFn ? cleanFn(rawUrls) : rawUrls;
      if (this.elements.urlsInput) this.elements.urlsInput.value = urlsText;

      const file = this.elements.fileInput?.files && this.elements.fileInput.files[0];

      if (!urlsText && !file) {
        this.showError('Please enter at least one YouTube link or ID, or select a .txt file.');
        return;
      }

      const ghToken = localStorage.getItem(storage.ghTokenKey) || '';
      if (!ghToken) {
        this.showError('GitHub Personal Access Token is required to dispatch ingestion. Please open Settings to configure your GitHub token.');
        return;
      }

      const defaultRepo = (CONFIG.github?.owner && CONFIG.github?.repo) ? `${CONFIG.github.owner}/${CONFIG.github.repo}` : 'mnswamedia/trove';
      const rawRepo = localStorage.getItem(storage.ghRepoKey) || defaultRepo;
      const repoParts = rawRepo.split('/').map(s => s.trim());
      if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
        this.showError('Invalid GitHub repository in Settings (expected "owner/repo").');
        return;
      }
      const [owner, repoName] = repoParts;

      let combinedTargets = urlsText;
      if (file) {
        try {
          const fileContent = await file.text();
          combinedTargets = (combinedTargets ? combinedTargets + '\n' : '') + fileContent;
        } catch (fErr) {
          this.showError('Failed to read the selected .txt file.');
          return;
        }
      }
      combinedTargets = cleanFn ? cleanFn(combinedTargets) : combinedTargets;

      const selectedFormat = document.querySelector('input[name="import-format"]:checked')?.value || 'm4a';
      const workflowFile = CONFIG.github?.workflowFile || 'ingest.yml';

      if (this.elements.errorMsg) this.elements.errorMsg.classList.add('hidden');
      if (this.elements.progressBox) this.elements.progressBox.classList.remove('hidden');
      if (this.elements.statusText) this.elements.statusText.innerText = 'Dispatching GitHub Actions workflow...';
      if (this.elements.statusSubtext) this.elements.statusSubtext.innerText = `Target: ${owner}/${repoName} (${workflowFile})`;
      if (this.elements.startBtn) {
        this.elements.startBtn.disabled = true;
        this.elements.startBtn.classList.add('opacity-75', 'pointer-events-none');
        this.elements.startBtn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Starting...</span>';
        if (window.lucide) window.lucide.createIcons();
      }

      const resetStartBtn = () => {
        if (this.elements.startBtn) {
          this.elements.startBtn.disabled = false;
          this.elements.startBtn.classList.remove('opacity-75', 'pointer-events-none');
          this.elements.startBtn.innerHTML = '<i data-lucide="download" class="w-3.5 h-3.5"></i><span>Start Download</span>';
          if (window.lucide) window.lucide.createIcons();
        }
      };

      try {
        await this.dispatchIngest({ targets: combinedTargets, format: selectedFormat });

        if (this.elements.statusText) this.elements.statusText.innerText = 'Dispatched successfully!';
        if (this.elements.statusSubtext) this.elements.statusSubtext.innerText = 'Sent to runner.';
        if (this.elements.startBtn) {
          this.elements.startBtn.innerHTML = '<i data-lucide="check" class="w-3.5 h-3.5 text-emerald-400"></i><span>Dispatched!</span>';
          if (window.lucide) window.lucide.createIcons();
        }

        setTimeout(() => {
          this.close();
          if (this.elements.urlsInput) this.elements.urlsInput.value = '';
          this.clearSelectedFile();
          resetStartBtn();

          const toastFn = showToast || window.Trove.utils?.showToast;
          if (toastFn) toastFn('Ingestion workflow dispatched successfully!');
        }, 500);

      } catch (err) {
        this.showError(err.message || 'Error triggering GitHub Actions runner.');
        resetStartBtn();
      }
    },

    setupEventListeners() {
      if (this.elements.openBtn) {
        this.elements.openBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.open();
        });
      }
      if (this.elements.mobileOpenBtn) {
        this.elements.mobileOpenBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.elements.mobileNavMenu) this.elements.mobileNavMenu.classList.add('hidden');
          this.open();
        });
      }
      if (this.elements.closeBtn) {
        this.elements.closeBtn.addEventListener('click', () => this.close());
      }
      if (this.elements.cancelBtn) {
        this.elements.cancelBtn.addEventListener('click', () => this.close());
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
      if (this.elements.form) {
        this.elements.form.addEventListener('submit', (e) => this.handleSubmit(e));
      }

      // Auto-clean pasted or entered URLs (strips ?si=..., ?su=..., &feature=..., etc.)
      if (this.elements.urlsInput) {
        const cleanInputTextarea = () => {
          if (!this.elements.urlsInput) return;
          const raw = this.elements.urlsInput.value;
          const cleanFn = window.Trove.utils?.cleanAllInputUrls || cleanAllInputUrls;
          if (!cleanFn) return;
          const cleaned = cleanFn(raw);
          if (cleaned !== raw) {
            const start = this.elements.urlsInput.selectionStart;
            const end = this.elements.urlsInput.selectionEnd;
            this.elements.urlsInput.value = cleaned;
            try {
              this.elements.urlsInput.setSelectionRange(
                Math.min(start, cleaned.length),
                Math.min(end, cleaned.length)
              );
            } catch (_) {}
          }
        };

        // Listen to 'input' event (handles mobile keyboard suggestion bar, Gboard, Samsung Keyboard, autofill)
        this.elements.urlsInput.addEventListener('input', () => {
          const val = this.elements.urlsInput.value;
          // If input contains query params (si=, su=, feature=, pp=, etc.) or youtu, clean immediately
          if (/[?&](?:si|su|feature|pp|igsh|utm_)/i.test(val) || val.includes('youtu.be') || val.includes('watch?')) {
            cleanInputTextarea();
          }
        });

        // Listen to 'paste' event
        this.elements.urlsInput.addEventListener('paste', () => {
          setTimeout(cleanInputTextarea, 0);
        });

        // Listen to 'change' and 'blur'
        this.elements.urlsInput.addEventListener('change', cleanInputTextarea);
        this.elements.urlsInput.addEventListener('blur', cleanInputTextarea);
      }

      // Dropzone & File input
      if (this.elements.fileDropzone && this.elements.fileInput) {
        this.elements.fileDropzone.addEventListener('click', () => {
          this.elements.fileInput.click();
        });

        this.elements.fileInput.addEventListener('change', (e) => {
          const file = e.target.files && e.target.files[0];
          if (file && this.elements.filenameDisplay) {
            this.elements.filenameDisplay.innerText = file.name;
            if (this.elements.clearFileBtn) this.elements.clearFileBtn.classList.remove('hidden');
          }
        });
      }

      if (this.elements.clearFileBtn) {
        this.elements.clearFileBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.clearSelectedFile();
        });
      }

      // Format radio pills
      document.querySelectorAll('.import-format-radio').forEach(radio => {
        radio.addEventListener('change', () => {
          document.querySelectorAll('.import-format-pill').forEach(pill => {
            pill.classList.remove('active', 'bg-white', 'text-jet-black', 'shadow-sm', 'dark:bg-[#242a38]', 'dark:text-[#f3f4f6]');
            pill.classList.add('text-stone-brown', 'dark:text-[#9aa4b2]');
          });
          const activeLabel = radio.closest('label');
          if (activeLabel) {
            const activePill = activeLabel.querySelector('.import-format-pill');
            if (activePill) {
              activePill.classList.add('active', 'bg-white', 'text-jet-black', 'shadow-sm', 'dark:bg-[#242a38]', 'dark:text-[#f3f4f6]');
              activePill.classList.remove('text-stone-brown', 'dark:text-[#9aa4b2]');
            }
          }
        });
      });
    }
  };

  // Export
  window.Trove.importer = ImportManager;

  // Backward compatibility aliases
  window.showImportModal = () => ImportManager.open();
  window.hideImportModal = () => ImportManager.close();
})();

