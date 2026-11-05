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
        hfRepoInput: document.getElementById('hf-repo-input'),
        ghTokenInput: document.getElementById('gh-token-input'),
        ghRepoInput: document.getElementById('gh-repo-input'),
        workerBaseUrlInput: document.getElementById('worker-base-url-input'),
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

      // Live bind device media cache limit slider
      const slider = document.getElementById('device-media-cache-slider');
      const valLabel = document.getElementById('device-media-cache-val');
      if (slider && valLabel) {
        slider.addEventListener('input', (e) => {
          valLabel.innerText = `${e.target.value} tracks`;
        });
      }
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
      if (this.elements.hfRepoInput) {
        const defaultHfRepo = CONFIG.repo?.id || 'mnswa/trove_dataset';
        this.elements.hfRepoInput.value = localStorage.getItem(storage.hfRepoKey) || defaultHfRepo;
      }
      if (this.elements.ghTokenInput) {
        this.elements.ghTokenInput.value = localStorage.getItem(storage.ghTokenKey) || '';
      }
      if (this.elements.ghRepoInput) {
        const defaultRepo = (CONFIG.github?.owner && CONFIG.github?.repo) ? `${CONFIG.github.owner}/${CONFIG.github.repo}` : 'mnswamedia/trove';
        this.elements.ghRepoInput.value = localStorage.getItem(storage.ghRepoKey) || defaultRepo;
      }
      if (this.elements.workerBaseUrlInput) {
        this.elements.workerBaseUrlInput.value =
          localStorage.getItem(storage.workerBaseUrlKey) ||
          localStorage.getItem(storage.workerRecsUrlKey) ||
          localStorage.getItem(storage.workerPlaylistsUrlKey) ||
          '';
      }
      if (this.elements.workerTokenInput) {
        this.elements.workerTokenInput.value = localStorage.getItem(storage.workerTokenKey) || '';
      }

      // Populate Audio & Device Storage Settings
      const slider = document.getElementById('device-media-cache-slider');
      const valLabel = document.getElementById('device-media-cache-val');
      if (slider) {
        const currentLimit = window.Trove.utils?.getDeviceMaxMediaCache ? window.Trove.utils.getDeviceMaxMediaCache() : 10;
        slider.value = currentLimit;
        if (valLabel) valLabel.innerText = `${currentLimit} tracks`;
      }

      const chkNorm = document.getElementById('chk-vol-normalization');
      if (chkNorm) {
        chkNorm.checked = localStorage.getItem('trove_vol_normalization') !== 'false';
      }

      const selCrossfade = document.getElementById('select-crossfade');
      if (selCrossfade) {
        selCrossfade.value = localStorage.getItem('trove_crossfade_sec') || '0';
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
      const hfRepo = (this.elements.hfRepoInput?.value || '').trim();
      const ghToken = (this.elements.ghTokenInput?.value || '').trim();
      const ghRepo = (this.elements.ghRepoInput?.value || '').trim();
      const workerBaseUrl = (this.elements.workerBaseUrlInput?.value || '').trim();
      const workerToken = (this.elements.workerTokenInput?.value || '').trim();

      // 1. HF Token & Dataset Repo
      const oldHfToken = state.token;
      const oldHfRepo = CONFIG.repo?.id;
      state.token = hfToken;
      if (hfToken) {
        localStorage.setItem(storage.tokenKey, hfToken);
      } else {
        localStorage.removeItem(storage.tokenKey);
      }

      if (hfRepo) {
        localStorage.setItem(storage.hfRepoKey, hfRepo);
        if (CONFIG.repo) {
          CONFIG.repo.id = hfRepo;
          const parts = hfRepo.split('/').map(s => s.trim());
          if (parts.length >= 2) {
            CONFIG.repo.owner = parts[0];
            CONFIG.repo.name = parts.slice(1).join('/');
          } else {
            CONFIG.repo.name = hfRepo;
          }
        }
      } else {
        localStorage.removeItem(storage.hfRepoKey);
      }

      if (this.elements.modalRepoId) {
        this.elements.modalRepoId.innerText = CONFIG.repo?.id || '--';
      }
      const repoIdDisplay = document.getElementById('repo-id-display');
      if (repoIdDisplay) {
        repoIdDisplay.innerText = CONFIG.repo?.id || '--';
      }

      // 2. GH Token & Repo
      if (ghToken) {
        localStorage.setItem(storage.ghTokenKey, ghToken);
      } else {
        localStorage.removeItem(storage.ghTokenKey);
      }
      if (ghRepo) {
        localStorage.setItem(storage.ghRepoKey, ghRepo);
        if (CONFIG.github) {
          const ghParts = ghRepo.split('/').map(s => s.trim());
          if (ghParts.length >= 2) {
            CONFIG.github.owner = ghParts[0];
            CONFIG.github.repo = ghParts.slice(1).join('/');
          }
        }
      } else {
        localStorage.removeItem(storage.ghRepoKey);
      }

      // 3. Cloudflare Worker URL & Secret
      if (workerBaseUrl) {
        localStorage.setItem(storage.workerBaseUrlKey, workerBaseUrl);
      } else {
        localStorage.removeItem(storage.workerBaseUrlKey);
      }
      if (workerToken) {
        localStorage.setItem(storage.workerTokenKey, workerToken);
      } else {
        localStorage.removeItem(storage.workerTokenKey);
      }

      // 4. Audio & Device Storage Settings
      const slider = document.getElementById('device-media-cache-slider');
      if (slider && window.Trove.utils?.setDeviceMaxMediaCache) {
        window.Trove.utils.setDeviceMaxMediaCache(slider.value);
      }

      const chkNorm = document.getElementById('chk-vol-normalization');
      if (chkNorm) {
        const normEnabled = chkNorm.checked;
        localStorage.setItem('trove_vol_normalization', normEnabled ? 'true' : 'false');
        if (window.Trove.equalizer) {
          window.Trove.equalizer.setVolumeNormalization(normEnabled);
        }
      }

      const selCrossfade = document.getElementById('select-crossfade');
      if (selCrossfade) {
        const cfSec = selCrossfade.value || '0';
        localStorage.setItem('trove_crossfade_sec', cfSec);
        if (window.Trove.player) {
          window.Trove.player.crossfadeSeconds = parseInt(cfSec, 10);
        }
      }

      this.updateHeaderBadge();
      this.close();
      if (showToast) showToast('Settings & credentials saved!');

      const repoChanged = Boolean(hfRepo && oldHfRepo && hfRepo !== oldHfRepo);
      // If HF Token changed or dataset repo changed or dataset empty, reload repository
      if (hfToken && (hfToken !== oldHfToken || repoChanged || (state.allItems && state.allItems.length === 0))) {
        if (window.Trove.explorer && typeof window.Trove.explorer.loadRepository === 'function') {
          window.Trove.explorer.loadRepository(true);
        }
      }
    },

    async purgeSelectedCache() {
      const purgeMedia = document.getElementById('purge-chk-media')?.checked;
      const purgeThumbs = document.getElementById('purge-chk-thumbs')?.checked;
      const purgeTree = document.getElementById('purge-chk-tree')?.checked;
      const purgeQueue = document.getElementById('purge-chk-queue')?.checked;
      const purgeTokens = document.getElementById('purge-chk-tokens')?.checked;
      const purgeSw = document.getElementById('purge-chk-sw')?.checked;

      if (!purgeMedia && !purgeThumbs && !purgeTree && !purgeQueue && !purgeTokens && !purgeSw) {
        if (showToast) showToast('Please select at least one item to purge.');
        return;
      }

      const btn = document.getElementById('btn-purge-cache');
      const statusLabel = document.getElementById('purge-status-label');
      let origBtnHtml = null;
      if (btn) {
        origBtnHtml = btn.innerHTML;
        btn.disabled = true;
        btn.classList.add('opacity-75', 'pointer-events-none');
        btn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Purging...</span>';
        if (window.lucide) window.lucide.createIcons();
      }
      if (statusLabel) statusLabel.innerText = 'Purging selected cache...';

      const state = window.Trove.state || {};
      const clearedList = [];

      try {
        // 1. Media Blobs
        if (purgeMedia) {
          if (window.Trove.utils?.clearMediaIDB) {
            await window.Trove.utils.clearMediaIDB();
          }
          clearedList.push('Media');
        }

        // 2. Thumbnails & Covers
        if (purgeThumbs) {
          if (window.Trove.utils?.clearThumbsIDB) {
            await window.Trove.utils.clearThumbsIDB();
          }
          if (window.Trove.player?.thumbnailCache) {
            window.Trove.player.thumbnailCache.clear();
          }
          // Reset visible thumbnail slots in DOM to default icon state
          document.querySelectorAll('.list-thumb-slot').forEach(slot => {
            const img = slot.querySelector('.list-thumb-img');
            const icon = slot.querySelector('.list-thumb-icon-wrapper');
            if (img) {
              img.classList.add('hidden');
              img.removeAttribute('src');
            }
            if (icon) icon.classList.remove('hidden');
          });
          clearedList.push('Covers');
        }

        // 3. Dataset File Tree
        if (purgeTree) {
          const keysToRemove = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('trove_fs_cache')) {
              keysToRemove.push(k);
            }
          }
          keysToRemove.forEach(k => localStorage.removeItem(k));
          state.tree = null;
          state.allItems = [];
          clearedList.push('Tree');
        }

        // 4. Playlists & Queue
        if (purgeQueue) {
          localStorage.removeItem('trove_active_queue');
          localStorage.removeItem('trove_playback_state');
          localStorage.removeItem('trove_recent_tracks');
          localStorage.removeItem('trove_playlists_cache');
          if (window.Trove.playlists && typeof window.Trove.playlists.clearQueue === 'function') {
            window.Trove.playlists.clearQueue();
          }
          clearedList.push('Queue');
        }

        // 5. Tokens & Configuration
        if (purgeTokens) {
          localStorage.removeItem(storage.tokenKey);
          localStorage.removeItem(storage.hfRepoKey);
          localStorage.removeItem(storage.ghTokenKey);
          localStorage.removeItem(storage.ghRepoKey);
          localStorage.removeItem(storage.workerBaseUrlKey);
          localStorage.removeItem(storage.workerTokenKey);
          localStorage.removeItem(storage.workerRecsUrlKey);
          localStorage.removeItem(storage.workerPlaylistsUrlKey);

          state.token = null;
          if (this.elements.hfTokenInput) this.elements.hfTokenInput.value = '';
          if (this.elements.ghTokenInput) this.elements.ghTokenInput.value = '';
          if (this.elements.workerBaseUrlInput) this.elements.workerBaseUrlInput.value = '';
          if (this.elements.workerTokenInput) this.elements.workerTokenInput.value = '';
          this.updateHeaderBadge();
          clearedList.push('Tokens');
        }

        // 6. Service Worker & App Shell
        if (purgeSw) {
          if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            for (const reg of regs) {
              await reg.unregister();
            }
          }
          if ('caches' in window) {
            const cacheKeys = await caches.keys();
            await Promise.all(cacheKeys.map(k => caches.delete(k)));
          }
          clearedList.push('App Shell');
        }

        const msg = `Purged: ${clearedList.join(', ')}`;
        if (statusLabel) statusLabel.innerText = msg;
        if (showToast) showToast(msg);

        // If SW was purged, reload page
        if (purgeSw) {
          setTimeout(() => {
            const cleanUrl = window.location.href.split('?')[0];
            window.location.replace(`${cleanUrl}?_ts=${Date.now()}`);
          }, 600);
          return;
        }

        // If tree was purged and tokens remain, reload repository cleanly
        if (purgeTree && state.token) {
          if (window.Trove.explorer && typeof window.Trove.explorer.loadRepository === 'function') {
            window.Trove.explorer.loadRepository(true);
          }
        }
      } catch (err) {
        console.error('Purge error:', err);
        if (statusLabel) statusLabel.innerText = 'Purge failed: ' + (err.message || err);
        if (showToast) showToast('Error purging cache');
      } finally {
        if (btn && origBtnHtml !== null) {
          btn.disabled = false;
          btn.classList.remove('opacity-75', 'pointer-events-none');
          btn.innerHTML = origBtnHtml;
          if (window.lucide) window.lucide.createIcons();
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

      if (this.elements.hfRepoInput && this.elements.modalRepoId) {
        this.elements.hfRepoInput.addEventListener('input', (e) => {
          this.elements.modalRepoId.innerText = (e.target.value || '').trim() || '--';
        });
      }

      // Cache Purge event listeners
      const btnPurgeSelectAll = document.getElementById('btn-purge-select-all');
      if (btnPurgeSelectAll) {
        btnPurgeSelectAll.addEventListener('click', () => {
          document.querySelectorAll('.purge-chk').forEach(chk => { chk.checked = true; });
        });
      }

      const btnPurgeDeselectAll = document.getElementById('btn-purge-deselect-all');
      if (btnPurgeDeselectAll) {
        btnPurgeDeselectAll.addEventListener('click', () => {
          document.querySelectorAll('.purge-chk').forEach(chk => { chk.checked = false; });
        });
      }

      const btnPurgeCache = document.getElementById('btn-purge-cache');
      if (btnPurgeCache) {
        btnPurgeCache.addEventListener('click', (e) => {
          e.preventDefault();
          this.purgeSelectedCache();
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

