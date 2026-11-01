/**
 * Trove Media Vault - YouTube Importer & GitHub Actions Ingest Dispatcher
 * URL parsing, batch .txt ingestion, and workflow dispatch.
 */
(function() {
  window.Trove = window.Trove || {};

  const CONFIG = window.APP_CONFIG || {};
  const repo = CONFIG.repo || {};
  const storage = CONFIG.storage || {};
  const { MotionAnim, cleanAllInputUrls } = window.Trove.utils || {};

  const ImportManager = {
    elements: {},

    get isOpen() {
      return this.elements.modal && this.elements.modal.style.display === 'flex';
    },

    init() {
      this.elements = {
        modal: document.getElementById('import-modal'),
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

    open() {
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
        this.elements.startBtn.classList.remove('opacity-50', 'pointer-events-none');
      }
      setTimeout(() => {
        if (this.elements.urlsInput) this.elements.urlsInput.focus();
      }, 50);

      if (window.lucide) window.lucide.createIcons();
      if (MotionAnim) MotionAnim.animateModalIn(this.elements.modal);
    },

    close() {
      if (!this.isOpen) return;
      if (MotionAnim) {
        MotionAnim.animateModalOut(this.elements.modal, () => {
          this.elements.modal.style.display = 'none';
        });
      } else {
        this.elements.modal.style.display = 'none';
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
      const urlsText = cleanAllInputUrls ? cleanAllInputUrls(rawUrls) : rawUrls;
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
      combinedTargets = cleanAllInputUrls ? cleanAllInputUrls(combinedTargets) : combinedTargets;

      const selectedFormat = document.querySelector('input[name="import-format"]:checked')?.value || 'm4a';
      const workflowFile = CONFIG.github?.workflowFile || 'ingest.yml';

      if (this.elements.errorMsg) this.elements.errorMsg.classList.add('hidden');
      if (this.elements.progressBox) this.elements.progressBox.classList.remove('hidden');
      if (this.elements.statusText) this.elements.statusText.innerText = 'Dispatching GitHub Actions workflow...';
      if (this.elements.statusSubtext) this.elements.statusSubtext.innerText = `Target: ${owner}/${repoName} (${workflowFile})`;
      if (this.elements.startBtn) {
        this.elements.startBtn.disabled = true;
        this.elements.startBtn.classList.add('opacity-50', 'pointer-events-none');
      }

      const state = window.Trove.state || {};

      try {
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
              targets: combinedTargets,
              format: selectedFormat,
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

        if (this.elements.statusText) this.elements.statusText.innerText = 'Dispatched to GitHub Actions!';
        if (this.elements.statusSubtext) this.elements.statusSubtext.innerText = 'Opening live Activity Monitor...';

        setTimeout(() => {
          this.close();
          if (this.elements.urlsInput) this.elements.urlsInput.value = '';
          this.clearSelectedFile();
          if (this.elements.startBtn) {
            this.elements.startBtn.disabled = false;
            this.elements.startBtn.classList.remove('opacity-50', 'pointer-events-none');
          }

          if (window.Trove.activity) {
            window.Trove.activity.showButton('Starting...', true, 'amber');
            window.Trove.activity.open();
            window.Trove.activity.startPolling();
          }
        }, 700);

      } catch (err) {
        this.showError(err.message || 'Error triggering GitHub Actions runner.');
        if (this.elements.startBtn) {
          this.elements.startBtn.disabled = false;
          this.elements.startBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
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
      if (this.elements.modal) {
        this.elements.modal.addEventListener('click', (e) => {
          const card = this.elements.modal.firstElementChild;
          if (card && !card.contains(e.target)) {
            this.close();
          }
        });
      }
      if (this.elements.form) {
        this.elements.form.addEventListener('submit', (e) => this.handleSubmit(e));
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

