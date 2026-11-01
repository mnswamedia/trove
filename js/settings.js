/**
 * Trove Media Vault - Settings Manager
 * Top Drawer Controller for Hugging Face, GitHub Runner, and Cloudflare Worker credentials.
 */
(function() {
  window.Trove = window.Trove || {};

  const CONFIG = window.APP_CONFIG || {};
  const storage = CONFIG.storage || {};
  const { MotionAnim, showToast } = window.Trove.utils || {};

  const SettingsManager = {
    elements: {},

    get isOpen() {
      return this.elements.drawer && this.elements.drawer.style.display === 'flex';
    },

    init() {
      this.elements = {
        drawer: document.getElementById('settings-drawer'),
        backdrop: document.getElementById('settings-backdrop'),
        form: document.getElementById('settings-form'),
        btnClose: document.getElementById('btn-close-settings'),
        btnCancel: document.getElementById('btn-cancel-settings'),
        btnSave: document.getElementById('btn-save-settings'),
        errorMsg: document.getElementById('settings-error-msg'),
        hfTokenInput: document.getElementById('hf-token-input'),
        ghTokenInput: document.getElementById('gh-token-input'),
        ghRepoInput: document.getElementById('gh-repo-input'),
        workerUrlInput: document.getElementById('worker-url-input'),
        workerLyricsUrlInput: document.getElementById('worker-lyrics-url-input'),
        workerTokenInput: document.getElementById('worker-token-input'),
        authSettingsBtn: document.getElementById('auth-settings-btn'),
        authBtnLabel: document.getElementById('auth-btn-label'),
        mobileAuthBtn: document.getElementById('mobile-auth-btn'),
        mobileAuthBadge: document.getElementById('mobile-auth-badge'),
        mobileNavMenu: document.getElementById('mobile-nav-menu'),
        modalRepoId: document.getElementById('modal-repo-id')
      };

      if (this.elements.modalRepoId) {
        this.elements.modalRepoId.innerText = CONFIG.repo?.id || '--';
      }

      this.updateHeaderBadge();
      this.setupEventListeners();
    },

    updateHeaderBadge() {
      const state = window.Trove.state || {};
      const token = state.token || localStorage.getItem(storage.tokenKey);
      if (this.elements.authBtnLabel) {
        this.elements.authBtnLabel.innerText = token ? 'Connected' : 'Token';
      }
      if (this.elements.mobileAuthBadge) {
        this.elements.mobileAuthBadge.innerText = token ? 'Connected' : 'Token';
      }
      if (this.elements.authSettingsBtn) {
        this.elements.authSettingsBtn.title = token ? 'Trove Settings (Vault Connected)' : 'Configure Hugging Face Token';
      }
    },

    open(errorText = '') {
      if (!this.elements.drawer) return;

      const state = window.Trove.state || {};

      // Populate token inputs from localStorage
      if (this.elements.hfTokenInput) {
        this.elements.hfTokenInput.value = state.token || localStorage.getItem(storage.tokenKey) || '';
      }
      if (this.elements.ghTokenInput) {
        this.elements.ghTokenInput.value = localStorage.getItem(storage.ghTokenKey) || '';
      }
      if (this.elements.ghRepoInput) {
        const defaultRepo = (CONFIG.github?.owner && CONFIG.github?.repo) ? `${CONFIG.github.owner}/${CONFIG.github.repo}` : 'mnswa/trove';
        this.elements.ghRepoInput.value = localStorage.getItem(storage.ghRepoKey) || defaultRepo;
      }
      if (this.elements.workerUrlInput) {
        this.elements.workerUrlInput.value = localStorage.getItem(storage.workerRecsUrlKey) || '';
      }
      if (this.elements.workerLyricsUrlInput) {
        this.elements.workerLyricsUrlInput.value = localStorage.getItem(storage.workerLyricsUrlKey) || '';
      }
      if (this.elements.workerTokenInput) {
        this.elements.workerTokenInput.value = localStorage.getItem(storage.workerTokenKey) || '';
      }

      if (errorText) {
        if (this.elements.errorMsg) {
          this.elements.errorMsg.innerText = errorText;
          this.elements.errorMsg.classList.remove('hidden');
        }
      } else {
        if (this.elements.errorMsg) this.elements.errorMsg.classList.add('hidden');
      }

      this.elements.drawer.style.display = 'flex';
      if (window.lucide) window.lucide.createIcons();
      if (MotionAnim) MotionAnim.animateTopDrawerIn(this.elements.drawer);

      setTimeout(() => {
        if (!state.token && this.elements.hfTokenInput) this.elements.hfTokenInput.focus();
      }, 100);
    },

    close() {
      if (!this.isOpen) return;
      if (MotionAnim) {
        MotionAnim.animateTopDrawerOut(this.elements.drawer, () => {
          this.elements.drawer.style.display = 'none';
          if (this.elements.errorMsg) this.elements.errorMsg.classList.add('hidden');
        });
      } else {
        this.elements.drawer.style.display = 'none';
        if (this.elements.errorMsg) this.elements.errorMsg.classList.add('hidden');
      }
    },

    saveAll() {
      const state = window.Trove.state || {};
      const hfToken = (this.elements.hfTokenInput?.value || '').trim();
      const ghToken = (this.elements.ghTokenInput?.value || '').trim();
      const ghRepo = (this.elements.ghRepoInput?.value || '').trim();
      const workerUrl = (this.elements.workerUrlInput?.value || '').trim();
      const workerLyricsUrl = (this.elements.workerLyricsUrlInput?.value || '').trim();
      const workerToken = (this.elements.workerTokenInput?.value || '').trim();

      // 1. HF Token
      const oldHfToken = state.token;
      state.token = hfToken;
      if (hfToken) {
        localStorage.setItem(storage.tokenKey, hfToken);
      } else {
        localStorage.removeItem(storage.tokenKey);
      }

      // 2. GH Token & Repo
      if (ghToken) {
        localStorage.setItem(storage.ghTokenKey, ghToken);
      } else {
        localStorage.removeItem(storage.ghTokenKey);
      }
      if (ghRepo) {
        localStorage.setItem(storage.ghRepoKey, ghRepo);
      } else {
        localStorage.removeItem(storage.ghRepoKey);
      }

      // 3. Cloudflare Worker URL & Secret
      if (workerUrl) {
        localStorage.setItem(storage.workerRecsUrlKey, workerUrl);
      } else {
        localStorage.removeItem(storage.workerRecsUrlKey);
      }
      if (workerLyricsUrl) {
        localStorage.setItem(storage.workerLyricsUrlKey, workerLyricsUrl);
      } else {
        localStorage.removeItem(storage.workerLyricsUrlKey);
      }
      if (workerToken) {
        localStorage.setItem(storage.workerTokenKey, workerToken);
      } else {
        localStorage.removeItem(storage.workerTokenKey);
      }

      this.updateHeaderBadge();
      this.close();
      if (showToast) showToast('Settings & credentials saved!');

      // If HF Token changed or dataset empty, reload repository
      if (hfToken && (hfToken !== oldHfToken || (state.allItems && state.allItems.length === 0))) {
        if (window.Trove.explorer && typeof window.Trove.explorer.loadRepository === 'function') {
          window.Trove.explorer.loadRepository(true);
        }
      }
    },

    setupEventListeners() {
      if (this.elements.form) {
        this.elements.form.addEventListener('submit', (e) => {
          e.preventDefault();
          this.saveAll();
        });
      }

      if (this.elements.btnSave) {
        this.elements.btnSave.addEventListener('click', (e) => {
          e.preventDefault();
          this.saveAll();
        });
      }

      if (this.elements.btnClose) {
        this.elements.btnClose.addEventListener('click', () => this.close());
      }

      if (this.elements.btnCancel) {
        this.elements.btnCancel.addEventListener('click', () => this.close());
      }

      if (this.elements.drawer) {
        this.elements.drawer.addEventListener('click', (e) => {
          const card = this.elements.drawer.querySelector('.relative');
          if (card && !card.contains(e.target)) {
            this.close();
          }
        });
      }

      if (this.elements.backdrop) {
        this.elements.backdrop.addEventListener('click', () => this.close());
      }

      if (this.elements.authSettingsBtn) {
        this.elements.authSettingsBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.open();
        });
      }

      if (this.elements.mobileAuthBtn) {
        this.elements.mobileAuthBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.elements.mobileNavMenu) this.elements.mobileNavMenu.classList.add('hidden');
          this.open();
        });
      }

      // Password visibility eye toggles
      document.querySelectorAll('.btn-toggle-token-eye').forEach((btn) => {
        btn.addEventListener('click', () => {
          const targetId = btn.getAttribute('data-target');
          const targetInput = targetId ? document.getElementById(targetId) : null;
          if (!targetInput) return;

          const isPass = targetInput.getAttribute('type') === 'password';
          targetInput.setAttribute('type', isPass ? 'text' : 'password');
          const icon = btn.querySelector('i');
          if (icon) {
            icon.setAttribute('data-lucide', isPass ? 'eye-off' : 'eye');
            if (window.lucide) window.lucide.createIcons();
          }
        });
      });
    }
  };

  // Export
  window.Trove.settings = SettingsManager;

  // Backward compatibility aliases
  window.openSettingsDrawer = (err) => SettingsManager.open(err);
  window.closeSettingsDrawer = () => SettingsManager.close();
  window.showAuthModal = (err) => SettingsManager.open(err);
  window.hideAuthModal = () => SettingsManager.close();
})();

