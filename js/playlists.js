/**
 * Trove Media Vault - Playlists & Queue Module (Cloudflare D1 Backed)
 * High-speed, cross-device persistent playlists & active queue.
 * Local-first with debounced Cloudflare D1 synchronization.
 */
(function() {
  window.Trove = window.Trove || {};

  const CONFIG = window.APP_CONFIG || {};
  const storage = CONFIG.storage || {};
  const { MotionAnim, showToast, formatTime } = window.Trove.utils || {};

  const PlaylistsManager = {
    activeTab: 'queue', // 'queue' | 'playlists'
    playlists: [], // [{ id, name, items: [], updatedAt }]
    currentDetailId: null,
    pendingSyncTimer: null,
    pendingAddTrack: null,
    elements: {},

    get isOpen() {
      return this.elements.drawer && this.elements.drawer.style.display === 'flex';
    },

    get isAddModalOpen() {
      return this.elements.addModal && this.elements.addModal.style.display === 'flex';
    },

    isCustomQueueActive() {
      const q = this.getQueue();
      return Array.isArray(q) && q.length > 0;
    },

    getQueue() {
      return this.getStoredQueue() || [];
    },

    getNextQueuedTrack() {
      const queue = this.getQueue();
      if (!queue || queue.length === 0) return null;
      const nextTrack = queue.shift();
      this.saveStoredQueue(queue);
      this.syncQueueToD1();
      this.updateQueueCounterUI();
      if (this.isOpen && this.activeTab === 'queue') {
        this.renderQueue();
      }
      return nextTrack;
    },

    updateQueueCounterUI() {
      const q = this.getQueue();
      if (this.elements.queueCountPill) {
        this.elements.queueCountPill.innerText = q.length;
      }
      if (window.Trove.player && typeof window.Trove.player.updateQueueCounter === 'function') {
        window.Trove.player.updateQueueCounter();
      }
    },

    getStoredQueue() {
      try {
        const raw = localStorage.getItem('trove_active_queue');
        if (raw) return JSON.parse(raw);
      } catch (_) {}
      return null;
    },

    saveStoredQueue(queue) {
      try {
        localStorage.setItem('trove_active_queue', JSON.stringify(queue || []));
      } catch (_) {}
    },

    init() {
      // One-time cleanup to ensure accidental folder/repo tracks are not retained in user queue
      if (!localStorage.getItem('trove_queue_v2_migrated')) {
        localStorage.removeItem('trove_active_queue');
        localStorage.setItem('trove_queue_v2_migrated', 'true');
        this.syncPlaylistToD1('_queue', 'Active Queue', []);
      }

      this.elements = {
        drawer: document.getElementById('playlists-bottom-sheet'),
        backdrop: document.getElementById('playlists-backdrop'),
        btnClose: document.getElementById('btn-close-playlists'),
        btnQueueToggle: document.getElementById('btn-queue-toggle'),
        btnPlaylistsHeader: document.getElementById('playlists-btn'),
        btnPlaylistsMobile: document.getElementById('mobile-playlists-btn'),
        tabBtnQueue: document.getElementById('tab-btn-queue'),
        tabBtnPlaylists: document.getElementById('tab-btn-playlists'),
        queueCountPill: document.getElementById('queue-count-pill'),
        playlistsCountPill: document.getElementById('playlists-count-pill'),
        queueActionsBar: document.getElementById('queue-actions-bar'),
        playlistsActionsBar: document.getElementById('playlists-actions-bar'),
        tabPaneQueue: document.getElementById('tab-pane-queue'),
        tabPanePlaylists: document.getElementById('tab-pane-playlists'),
        queueList: document.getElementById('queue-list'),
        queueEmpty: document.getElementById('queue-empty'),
        playlistsGrid: document.getElementById('playlists-grid'),
        playlistsEmpty: document.getElementById('playlists-empty'),
        btnSaveQueue: document.getElementById('btn-save-queue-as-playlist'),
        btnClearQueue: document.getElementById('btn-clear-queue'),
        btnNewPlaylist: document.getElementById('btn-new-playlist'),
        btnCreateFirst: document.getElementById('btn-create-first-playlist'),
        btnBackupHf: document.getElementById('btn-backup-playlists-hf'),
        btnRestoreHf: document.getElementById('btn-restore-playlists-hf'),
        playlistDetailView: document.getElementById('playlist-detail-view'),
        btnBackToPlaylists: document.getElementById('btn-back-to-playlists'),
        detailTitle: document.getElementById('detail-playlist-title'),
        detailMeta: document.getElementById('detail-playlist-meta'),
        detailTrackList: document.getElementById('detail-track-list'),
        btnPlayAllPlaylist: document.getElementById('btn-play-all-playlist'),
        btnDeletePlaylist: document.getElementById('btn-delete-playlist'),
        syncBadge: document.getElementById('playlists-sync-badge'),

        // Add to Playlist Drawer
        addModal: document.getElementById('add-to-playlist-modal'),
        addBackdrop: document.getElementById('add-playlist-backdrop'),
        closeAddModal: document.getElementById('close-add-playlist-modal'),
        addModalTrackName: document.getElementById('add-modal-track-name'),
        btnQuickAddQueue: document.getElementById('btn-quick-add-to-queue'),
        addModalList: document.getElementById('add-modal-playlists-list'),
        inputNewPlaylistInline: document.getElementById('input-new-playlist-inline'),
        btnCreatePlaylistInline: document.getElementById('btn-create-playlist-inline')
      };

      this.setupEventListeners();
      this.loadLocalCache();
      this.fetchFromD1();
      // If local cache is empty, attempt silent background restore from Hugging Face backup
      if (this.playlists.length === 0) {
        this.restoreFromHuggingFace(true);
      }
    },

    setupEventListeners() {
      // Open / Close Drawer
      if (this.elements.btnQueueToggle) {
        this.elements.btnQueueToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          this.open('queue');
        });
      }

      if (this.elements.btnPlaylistsHeader) {
        this.elements.btnPlaylistsHeader.addEventListener('click', (e) => {
          e.stopPropagation();
          this.open('playlists');
        });
      }

      if (this.elements.btnPlaylistsMobile) {
        this.elements.btnPlaylistsMobile.addEventListener('click', (e) => {
          e.stopPropagation();
          const mobileNav = document.getElementById('mobile-nav-menu');
          if (mobileNav) mobileNav.classList.add('hidden');
          this.open('playlists');
        });
      }

      if (this.elements.btnClose) {
        this.elements.btnClose.addEventListener('click', () => this.close());
      }

      // Outside click dismiss for Drawer
      if (this.elements.drawer) {
        this.elements.drawer.addEventListener('click', (e) => {
          const card = this.elements.drawer.querySelector('.relative');
          if (card && !card.contains(e.target)) {
            this.close();
          }
        });
      }

      // Dismiss for Add Drawer
      if (this.elements.addBackdrop) {
        this.elements.addBackdrop.addEventListener('click', () => this.closeAddModal());
      }
      if (this.elements.addModal) {
        this.elements.addModal.addEventListener('click', (e) => {
          const card = this.elements.addModal.querySelector('.relative');
          if (card && !card.contains(e.target)) {
            this.closeAddModal();
          }
        });
      }

      if (this.elements.closeAddModal) {
        this.elements.closeAddModal.addEventListener('click', () => this.closeAddModal());
      }

      // Tabs
      if (this.elements.tabBtnQueue) {
        this.elements.tabBtnQueue.addEventListener('click', () => this.switchTab('queue'));
      }
      if (this.elements.tabBtnPlaylists) {
        this.elements.tabBtnPlaylists.addEventListener('click', () => this.switchTab('playlists'));
      }

      // Queue Actions
      if (this.elements.btnClearQueue) {
        this.elements.btnClearQueue.addEventListener('click', () => this.clearQueue());
      }
      if (this.elements.btnSaveQueue) {
        this.elements.btnSaveQueue.addEventListener('click', () => this.promptSaveQueueAsPlaylist());
      }

      // Playlist Actions
      if (this.elements.btnNewPlaylist) {
        this.elements.btnNewPlaylist.addEventListener('click', () => this.promptCreatePlaylist());
      }
      if (this.elements.btnCreateFirst) {
        this.elements.btnCreateFirst.addEventListener('click', () => this.promptCreatePlaylist());
      }
      if (this.elements.btnBackupHf) {
        this.elements.btnBackupHf.addEventListener('click', () => this.backupToHuggingFace());
      }
      if (this.elements.btnRestoreHf) {
        this.elements.btnRestoreHf.addEventListener('click', () => this.restoreFromHuggingFace());
      }

      // Subview Details Back
      if (this.elements.btnBackToPlaylists) {
        this.elements.btnBackToPlaylists.addEventListener('click', () => {
          this.elements.playlistDetailView.classList.add('hidden');
          this.currentDetailId = null;
        });
      }

      // Subview Play All
      if (this.elements.btnPlayAllPlaylist) {
        this.elements.btnPlayAllPlaylist.addEventListener('click', () => {
          if (!this.currentDetailId) return;
          if (this.currentDetailId === '_favorites') {
            this.playFavorites();
            return;
          }
          const pl = this.playlists.find(p => p.id === this.currentDetailId);
          if (pl && pl.items.length > 0) {
            this.playPlaylist(pl);
          }
        });
      }

      window.addEventListener('trove:favorites-changed', () => {
        this.syncFavoritesToD1();
        if (this.isOpen && this.activeTab === 'playlists') {
          this.renderPlaylists();
        }
      });

      // Subview Delete
      if (this.elements.btnDeletePlaylist) {
        this.elements.btnDeletePlaylist.addEventListener('click', () => {
          if (!this.currentDetailId) return;
          const pl = this.playlists.find(p => p.id === this.currentDetailId);
          if (pl && confirm(`Delete playlist "${pl.name}"?`)) {
            this.deletePlaylist(pl.id);
            this.elements.playlistDetailView.classList.add('hidden');
            this.currentDetailId = null;
          }
        });
      }

      // Inline Add Modal Buttons
      if (this.elements.btnQuickAddQueue) {
        this.elements.btnQuickAddQueue.addEventListener('click', () => {
          if (this.pendingAddTrack) {
            this.addToQueue(this.pendingAddTrack);
            this.closeAddModal();
          }
        });
      }

      if (this.elements.btnCreatePlaylistInline && this.elements.inputNewPlaylistInline) {
        this.elements.btnCreatePlaylistInline.addEventListener('click', () => {
          const name = this.elements.inputNewPlaylistInline.value.trim();
          if (name) {
            const initial = this.pendingAddTrack ? [this.pendingAddTrack] : [];
            this.createPlaylist(name, initial);
            this.elements.inputNewPlaylistInline.value = '';
            this.closeAddModal();
          }
        });
      }

      // Player expanded bar "Save / Add to Playlist" button
      const btnPlayerAdd = document.getElementById('btn-player-add-playlist');
      if (btnPlayerAdd) {
        btnPlayerAdd.addEventListener('click', () => {
          const player = window.Trove.player;
          if (player && player.currentTrack) {
            this.openAddModal(player.currentTrack);
          } else {
            if (showToast) showToast('No media track playing right now');
          }
        });
      }
    },

    open(tab = 'queue') {
      if (!this.elements.drawer) return;
      this.elements.drawer.style.display = 'flex';
      if (this.elements.playlistDetailView) this.elements.playlistDetailView.classList.add('hidden');
      this.currentDetailId = null;
      this.switchTab(tab);
      if (MotionAnim) MotionAnim.animateSheetIn(this.elements.drawer);
      if (window.lucide) window.lucide.createIcons();
    },

    close() {
      if (!this.isOpen) return;
      if (MotionAnim) {
        MotionAnim.animateSheetOut(this.elements.drawer, () => {
          this.elements.drawer.style.display = 'none';
        });
      } else {
        this.elements.drawer.style.display = 'none';
      }
    },

    switchTab(tab) {
      this.activeTab = tab;
      const isQueue = tab === 'queue';

      if (this.elements.tabBtnQueue) {
        this.elements.tabBtnQueue.className = isQueue
          ? 'px-3 py-1 rounded-lg text-xs font-semibold transition bg-white dark:bg-[#282f3e] text-jet-black dark:text-[#f3f4f6] shadow-xs flex items-center gap-1.5'
          : 'px-3 py-1 rounded-lg text-xs font-medium transition text-stone-brown dark:text-[#9aa4b2] hover:text-black dark:hover:text-white flex items-center gap-1.5';
      }

      if (this.elements.tabBtnPlaylists) {
        this.elements.tabBtnPlaylists.className = !isQueue
          ? 'px-3 py-1 rounded-lg text-xs font-semibold transition bg-white dark:bg-[#282f3e] text-jet-black dark:text-[#f3f4f6] shadow-xs flex items-center gap-1.5'
          : 'px-3 py-1 rounded-lg text-xs font-medium transition text-stone-brown dark:text-[#9aa4b2] hover:text-black dark:hover:text-white flex items-center gap-1.5';
      }

      if (this.elements.queueActionsBar) {
        if (isQueue) this.elements.queueActionsBar.classList.remove('hidden');
        else this.elements.queueActionsBar.classList.add('hidden');
      }

      if (this.elements.playlistsActionsBar) {
        if (!isQueue) this.elements.playlistsActionsBar.classList.remove('hidden');
        else this.elements.playlistsActionsBar.classList.add('hidden');
      }

      if (this.elements.tabPaneQueue) {
        if (isQueue) this.elements.tabPaneQueue.classList.remove('hidden');
        else this.elements.tabPaneQueue.classList.add('hidden');
      }

      if (this.elements.tabPanePlaylists) {
        if (!isQueue) this.elements.tabPanePlaylists.classList.remove('hidden');
        else this.elements.tabPanePlaylists.classList.add('hidden');
      }

      if (isQueue) {
        this.renderQueue();
      } else {
        this.renderPlaylists();
      }

      if (window.lucide) window.lucide.createIcons();
    },

    renderQueue() {
      const player = window.Trove.player || {};
      const queue = this.getQueue();
      const currentTrack = player.currentTrack;

      if (this.elements.queueCountPill) {
        this.elements.queueCountPill.innerText = queue.length;
      }

      if (queue.length === 0) {
        if (this.elements.queueEmpty) this.elements.queueEmpty.classList.remove('hidden');
        if (this.elements.queueList) this.elements.queueList.innerHTML = '';
        return;
      }

      if (this.elements.queueEmpty) this.elements.queueEmpty.classList.add('hidden');
      if (!this.elements.queueList) return;

      this.elements.queueList.innerHTML = '';

      queue.forEach((item, index) => {
        const isCurrent = currentTrack && currentTrack.path === item.path;
        const row = document.createElement('div');
        row.className = `flex items-center justify-between p-2 sm:p-2.5 rounded-xl border transition ${
          isCurrent
            ? 'bg-almond-cream/50 dark:bg-[#202633] border-stone-brown/40 dark:border-[#3b4356] shadow-xs'
            : 'bg-white dark:bg-[#1a1e27] border-almond-cream/80 dark:border-[#262c38] hover:bg-almond-cream/30 dark:hover:bg-[#1e232e]'
        }`;

        row.innerHTML = `
          <div class="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer select-none">
            <span class="w-5 text-center text-xs font-mono font-medium ${isCurrent ? 'text-amber-600 dark:text-amber-400 font-bold' : 'text-stone-brown/60 dark:text-[#758092]'}">
              ${isCurrent ? '▶' : index + 1}
            </span>
            <div class="min-w-0 flex-1">
              <p class="text-xs sm:text-sm font-semibold truncate ${isCurrent ? 'text-black dark:text-white font-bold' : 'text-stone-brown dark:text-[#c6ac8f]'}">
                ${item.name}
              </p>
              <p class="text-[10px] font-mono text-stone-brown/60 dark:text-[#8b95a5] truncate">
                ${item.parentDir || 'Vault'}
              </p>
            </div>
          </div>
          <div class="flex items-center gap-1 shrink-0 ml-2">
            <button type="button" class="btn-remove-queue p-1.5 rounded-lg text-stone-brown/60 hover:text-red-500 hover:bg-red-500/10 transition" title="Remove from queue">
              <i data-lucide="x" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        `;

        // Click row -> play track and consume from queue
        const clickArea = row.firstElementChild;
        clickArea.addEventListener('click', () => {
          const [clicked] = queue.splice(index, 1);
          this.saveStoredQueue(queue);
          this.syncQueueToD1();
          this.renderQueue();
          this.updateQueueCounterUI();
          if (player.playTrack) {
            player.playTrack(clicked);
          }
        });

        // Click remove
        const btnRemove = row.querySelector('.btn-remove-queue');
        btnRemove.addEventListener('click', (e) => {
          e.stopPropagation();
          this.removeFromQueue(index);
        });

        this.elements.queueList.appendChild(row);
      });

      if (window.lucide) window.lucide.createIcons();
    },

    renderPlaylists() {
      const list = this.playlists.filter(p => p.id !== '_queue');
      const favPaths = window.Trove.utils?.getFavorites ? window.Trove.utils.getFavorites() : [];

      if (this.elements.playlistsCountPill) {
        this.elements.playlistsCountPill.innerText = list.length + (favPaths.length > 0 ? 1 : 0);
      }

      if (this.elements.playlistsEmpty) this.elements.playlistsEmpty.classList.add('hidden');
      if (!this.elements.playlistsGrid) return;

      this.elements.playlistsGrid.innerHTML = '';

      // 1. Smart "Liked Songs" Card
      const favCard = document.createElement('div');
      favCard.className = 'p-3.5 sm:p-4 rounded-2xl bg-rose-50/70 dark:bg-[#1f1622] border border-rose-200/80 dark:border-rose-900/40 shadow-xs hover:border-rose-300 dark:hover:border-rose-800/60 transition flex flex-col justify-between gap-3 group cursor-pointer';
      favCard.innerHTML = `
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-8 h-8 rounded-xl bg-rose-500/15 dark:bg-rose-500/20 flex items-center justify-center text-rose-600 dark:text-rose-400 shrink-0">
              <i data-lucide="heart" class="w-4 h-4 fill-current"></i>
            </div>
            <div class="min-w-0">
              <h4 class="text-xs sm:text-sm font-bold text-black dark:text-[#f3f4f6] truncate">Liked Songs</h4>
              <p class="text-[10px] font-mono text-stone-brown/60 dark:text-[#8b95a5]">${favPaths.length} ${favPaths.length === 1 ? 'track' : 'tracks'}</p>
            </div>
          </div>
          <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase bg-rose-500/10 text-rose-600 dark:text-rose-400">Smart</span>
        </div>

        <div class="flex items-center justify-between pt-2 border-t border-rose-200/50 dark:border-rose-900/30">
          <span class="text-[10px] font-mono text-stone-brown/60 dark:text-[#758092]">Tap to inspect</span>
          <button type="button" class="btn-card-play px-2.5 py-1 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white transition shadow-xs flex items-center gap-1" title="Play Liked Songs">
            <i data-lucide="play" class="w-3 h-3"></i>
            <span>Play</span>
          </button>
        </div>
      `;

      favCard.addEventListener('click', (e) => {
        if (e.target.closest('.btn-card-play')) return;
        this.openFavoritesDetail();
      });

      const btnPlayFav = favCard.querySelector('.btn-card-play');
      btnPlayFav.addEventListener('click', (e) => {
        e.stopPropagation();
        this.playFavorites();
      });

      this.elements.playlistsGrid.appendChild(favCard);

      list.forEach((pl) => {
        const count = pl.items ? pl.items.length : 0;
        const card = document.createElement('div');
        card.className = 'p-3.5 sm:p-4 rounded-2xl bg-white dark:bg-[#1a1e27] border border-almond-cream/80 dark:border-[#282e3b] shadow-xs hover:border-stone-brown/40 dark:hover:border-[#384152] transition flex flex-col justify-between gap-3 group cursor-pointer';

        card.innerHTML = `
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="w-8 h-8 rounded-xl bg-almond-cream/50 dark:bg-[#252b38] flex items-center justify-center text-stone-brown dark:text-[#c6ac8f] shrink-0">
                <i data-lucide="music-2" class="w-4 h-4"></i>
              </div>
              <div class="min-w-0">
                <h4 class="text-xs sm:text-sm font-bold text-black dark:text-[#f3f4f6] truncate">${pl.name}</h4>
                <p class="text-[10px] font-mono text-stone-brown/60 dark:text-[#8b95a5]">${count} ${count === 1 ? 'track' : 'tracks'}</p>
              </div>
            </div>
            <button type="button" class="btn-card-delete p-1 rounded-lg text-stone-brown/40 hover:text-red-500 hover:bg-red-500/10 transition" title="Delete playlist">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>

          <div class="flex items-center justify-between pt-2 border-t border-almond-cream/40 dark:border-[#252a36]">
            <span class="text-[10px] font-mono text-stone-brown/60 dark:text-[#758092]">Tap to inspect</span>
            <button type="button" class="btn-card-play px-2.5 py-1 rounded-lg text-xs font-semibold bg-jet-black text-white dark:bg-[#f3f4f6] dark:text-[#0e1116] transition shadow-xs flex items-center gap-1" title="Play playlist">
              <i data-lucide="play" class="w-3 h-3"></i>
              <span>Play</span>
            </button>
          </div>
        `;

        card.addEventListener('click', (e) => {
          if (e.target.closest('.btn-card-delete') || e.target.closest('.btn-card-play')) return;
          this.openPlaylistDetail(pl.id);
        });

        const btnPlay = card.querySelector('.btn-card-play');
        btnPlay.addEventListener('click', (e) => {
          e.stopPropagation();
          this.playPlaylist(pl);
        });

        const btnDel = card.querySelector('.btn-card-delete');
        btnDel.addEventListener('click', (e) => {
          e.stopPropagation();
          if (confirm(`Delete playlist "${pl.name}"?`)) {
            this.deletePlaylist(pl.id);
          }
        });

        this.elements.playlistsGrid.appendChild(card);
      });

      if (window.lucide) window.lucide.createIcons();
    },

    openPlaylistDetail(id) {
      if (id === '_favorites') {
        this.openFavoritesDetail();
        return;
      }

      const pl = this.playlists.find(p => p.id === id);
      if (!pl) return;

      this.currentDetailId = id;
      if (this.elements.btnDeletePlaylist) {
        this.elements.btnDeletePlaylist.classList.remove('hidden');
      }
      if (this.elements.detailTitle) this.elements.detailTitle.innerText = pl.name;
      const count = pl.items ? pl.items.length : 0;
      if (this.elements.detailMeta) {
        this.elements.detailMeta.innerText = `${count} ${count === 1 ? 'track' : 'tracks'}`;
      }

      if (this.elements.detailTrackList) {
        this.elements.detailTrackList.innerHTML = '';
        if (count === 0) {
          this.elements.detailTrackList.innerHTML = `
            <div class="py-12 flex flex-col items-center justify-center text-center gap-2 text-stone-brown/60 dark:text-[#8b95a5]">
              <i data-lucide="music" class="w-8 h-8 text-stone-brown/40 dark:text-[#525d70]"></i>
              <p class="text-xs">This playlist is empty. Add tracks from the vault!</p>
            </div>
          `;
        } else {
          pl.items.forEach((item, index) => {
            const row = document.createElement('div');
            row.className = 'flex items-center justify-between p-2 rounded-xl bg-white dark:bg-[#1a1e27] border border-almond-cream/80 dark:border-[#262c38] hover:bg-almond-cream/30 dark:hover:bg-[#1e232e] transition text-xs';
            row.innerHTML = `
              <div class="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer">
                <span class="w-5 text-center font-mono text-stone-brown/60 dark:text-[#758092]">${index + 1}</span>
                <span class="font-medium text-black dark:text-[#f3f4f6] truncate">${item.name}</span>
              </div>
              <button type="button" class="btn-remove-from-pl p-1 rounded-lg text-stone-brown/50 hover:text-red-500 hover:bg-red-500/10 transition" title="Remove track">
                <i data-lucide="x" class="w-3.5 h-3.5"></i>
              </button>
            `;

            row.firstElementChild.addEventListener('click', () => {
              const player = window.Trove.player;
              if (player && player.setCustomQueue) {
                player.setCustomQueue(pl.items, index);
                this.saveStoredQueue(pl.items);
                this.syncQueueToD1();
              }
            });

            row.querySelector('.btn-remove-from-pl').addEventListener('click', (e) => {
              e.stopPropagation();
              pl.items.splice(index, 1);
              this.saveLocalCache();
              this.syncPlaylistToD1(pl.id);
              this.openPlaylistDetail(pl.id);
              if (showToast) showToast('Track removed from playlist');
            });

            this.elements.detailTrackList.appendChild(row);
          });
        }
      }

      if (this.elements.playlistDetailView) {
        this.elements.playlistDetailView.classList.remove('hidden');
      }
      if (window.lucide) window.lucide.createIcons();
    },

    openFavoritesDetail() {
      const tracks = this.getFavoriteTracks();
      this.currentDetailId = '_favorites';
      if (this.elements.detailTitle) this.elements.detailTitle.innerText = 'Liked Songs';
      if (this.elements.detailMeta) {
        this.elements.detailMeta.innerText = `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`;
      }
      if (this.elements.btnDeletePlaylist) {
        this.elements.btnDeletePlaylist.classList.add('hidden');
      }

      if (this.elements.detailTrackList) {
        this.elements.detailTrackList.innerHTML = '';
        if (tracks.length === 0) {
          this.elements.detailTrackList.innerHTML = `
            <div class="py-12 flex flex-col items-center justify-center text-center gap-2 text-stone-brown/60 dark:text-[#8b95a5]">
              <i data-lucide="heart" class="w-8 h-8 text-stone-brown/40 dark:text-[#525d70]"></i>
              <p class="text-xs">No liked songs yet! Tap the heart icon on any song to add it here.</p>
            </div>
          `;
        } else {
          tracks.forEach((item, index) => {
            const row = document.createElement('div');
            row.className = 'p-2.5 sm:p-3 rounded-xl bg-white dark:bg-[#1a1e27] border border-almond-cream/60 dark:border-[#282e3b] flex items-center justify-between gap-3 group hover:border-stone-brown/40 dark:hover:border-[#384152] transition cursor-pointer';
            row.innerHTML = `
              <div class="flex items-center gap-2.5 min-w-0">
                <span class="w-5 text-center text-[10px] font-mono text-stone-brown/50 dark:text-[#6b7688] shrink-0">${index + 1}</span>
                <div class="min-w-0">
                  <h5 class="text-xs sm:text-sm font-semibold text-black dark:text-[#f3f4f6] truncate">${escapeHtml(item.name || item.path.split('/').pop())}</h5>
                  <p class="text-[10px] font-mono text-stone-brown/60 dark:text-[#8b95a5] truncate">${escapeHtml(item.path)}</p>
                </div>
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <button type="button" class="btn-fav-remove p-1.5 rounded-lg text-rose-500 hover:text-stone-brown hover:bg-almond-cream/30 dark:hover:bg-[#252a36] transition" title="Unlike song">
                  <i data-lucide="heart" class="w-4 h-4 fill-current"></i>
                </button>
              </div>
            `;

            row.addEventListener('click', (e) => {
              if (e.target.closest('.btn-fav-remove')) return;
              const player = window.Trove.player;
              if (player && typeof player.setCustomContext === 'function') {
                player.setCustomContext(tracks, index);
              }
            });

            const btnRemove = row.querySelector('.btn-fav-remove');
            btnRemove.addEventListener('click', (e) => {
              e.stopPropagation();
              if (window.Trove.utils?.toggleFavorite) {
                window.Trove.utils.toggleFavorite(item.path);
                this.openFavoritesDetail();
              }
            });

            this.elements.detailTrackList.appendChild(row);
          });
        }
      }

      if (this.elements.playlistDetailView) {
        this.elements.playlistDetailView.classList.remove('hidden');
      }
      if (window.lucide) window.lucide.createIcons();
    },

    getFavoriteTracks() {
      const favPaths = window.Trove.utils?.getFavorites ? window.Trove.utils.getFavorites() : [];
      const state = window.Trove.state || {};
      const allItems = state.allItems || [];
      return favPaths.map(p => {
        const found = allItems.find(i => i.path === p);
        if (found) return found;
        const name = p.split('/').pop();
        return { name, path: p, category: 'music', isDir: false };
      });
    },

    playFavorites() {
      const tracks = this.getFavoriteTracks();
      if (tracks.length === 0) {
        if (showToast) showToast('No liked songs yet! Tap the heart icon on any song.');
        return;
      }
      const player = window.Trove.player;
      if (player && typeof player.setCustomContext === 'function') {
        player.setCustomContext(tracks, 0);
        if (showToast) showToast(`Playing Liked Songs (${tracks.length} tracks)`);
      }
    },

    playPlaylist(pl) {
      if (!pl || !pl.items || pl.items.length === 0) {
        if (showToast) showToast('Playlist is empty');
        return;
      }

      const player = window.Trove.player;
      if (player && typeof player.setCustomContext === 'function') {
        player.setCustomContext(pl.items, 0);
        if (showToast) showToast(`Playing "${pl.name}" (${pl.items.length} tracks)`);
      }
    },

    addToQueue(track, playNext = false) {
      if (!track) return;
      const queue = this.getQueue();
      if (playNext) {
        queue.unshift(track);
      } else {
        queue.push(track);
      }

      this.saveStoredQueue(queue);
      this.syncQueueToD1();
      this.updateQueueCounterUI();

      if (this.isOpen && this.activeTab === 'queue') {
        this.renderQueue();
      }

      const displayName = (track.name || '').replace(/\.[a-zA-Z0-9]+$/, '');
      if (showToast) showToast(`Added "${displayName}" to queue`);
    },

    removeFromQueue(index) {
      const queue = this.getQueue();
      if (index >= 0 && index < queue.length) {
        queue.splice(index, 1);
        this.saveStoredQueue(queue);
        this.syncQueueToD1();
        this.renderQueue();
        this.updateQueueCounterUI();
      }
    },

    clearQueue() {
      this.saveStoredQueue([]);
      this.syncQueueToD1();
      this.renderQueue();
      this.updateQueueCounterUI();
      if (showToast) showToast('Queue cleared');
    },

    promptSaveQueueAsPlaylist() {
      const queue = this.getQueue();
      if (!queue || queue.length === 0) {
        if (showToast) showToast('Queue is empty');
        return;
      }

      const name = prompt('Name your new playlist:', `Queue (${new Date().toLocaleDateString()})`);
      if (name && name.trim()) {
        this.createPlaylist(name.trim(), [...queue]);
      }
    },

    promptCreatePlaylist() {
      const name = prompt('Enter new playlist name:');
      if (name && name.trim()) {
        this.createPlaylist(name.trim(), []);
      }
    },

    createPlaylist(name, initialItems = []) {
      const id = 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const newPl = {
        id,
        name,
        items: initialItems,
        updatedAt: Date.now()
      };

      this.playlists.unshift(newPl);
      this.saveLocalCache();
      this.syncPlaylistToD1(id);
      this.renderPlaylists();
      if (showToast) showToast(`Playlist "${name}" created!`);
    },

    deletePlaylist(id) {
      this.playlists = this.playlists.filter(p => p.id !== id);
      this.saveLocalCache();
      this.renderPlaylists();

      const workerUrl = this.getWorkerUrl();
      if (workerUrl) {
        const cleanBase = workerUrl.replace(/\/+$/, '');
        const targetUrl = cleanBase.endsWith('/playlists') ? `${cleanBase}/${encodeURIComponent(id)}` : `${cleanBase}/playlists/${encodeURIComponent(id)}`;
        const headers = this.getAuthHeaders();
        fetch(targetUrl, { method: 'DELETE', headers }).catch(console.warn);
      }

      if (showToast) showToast('Playlist deleted');
    },

    openAddModal(track) {
      if (!track) return;
      this.pendingAddTrack = track;
      if (this.elements.addModalTrackName) {
        this.elements.addModalTrackName.innerText = track.name;
      }

      if (this.elements.addModalList) {
        this.elements.addModalList.innerHTML = '';
        const list = this.playlists.filter(p => p.id !== '_queue');

        if (list.length === 0) {
          this.elements.addModalList.innerHTML = `
            <div class="py-3 text-center text-xs text-stone-brown/60 dark:text-[#8b95a5]">
              No custom playlists yet. Create one below!
            </div>
          `;
        } else {
          list.forEach(pl => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'w-full px-3 py-2 text-xs font-medium rounded-xl bg-white dark:bg-[#1a1e27] border border-almond-cream/80 dark:border-[#282e3b] text-jet-black dark:text-[#f3f4f6] hover:bg-almond-cream/40 dark:hover:bg-[#252b38] transition flex items-center justify-between text-left';
            btn.innerHTML = `
              <span class="font-semibold truncate">${pl.name}</span>
              <span class="text-[10px] font-mono text-stone-brown/60 dark:text-[#758092] shrink-0">${pl.items.length} tracks</span>
            `;
            btn.addEventListener('click', () => {
              pl.items.push(track);
              this.saveLocalCache();
              this.syncPlaylistToD1(pl.id);
              this.closeAddModal();
              if (showToast) showToast(`Added to "${pl.name}"!`);
            });
            this.elements.addModalList.appendChild(btn);
          });
        }
      }

      if (this.elements.addModal) {
        this.elements.addModal.style.display = 'flex';
        if (window.lucide) window.lucide.createIcons();
        if (MotionAnim) MotionAnim.animateSheetIn(this.elements.addModal);
      }
    },

    closeAddModal() {
      if (!this.elements.addModal || this.elements.addModal.style.display === 'none') return;
      this.pendingAddTrack = null;
      if (MotionAnim) {
        MotionAnim.animateSheetOut(this.elements.addModal, () => {
          this.elements.addModal.style.display = 'none';
        });
      } else {
        this.elements.addModal.style.display = 'none';
      }
    },

    // Persistence & D1 Synchronization
    loadLocalCache() {
      try {
        const raw = localStorage.getItem('trove_playlists_cache');
        if (raw) {
          this.playlists = JSON.parse(raw);
        }
      } catch (_) {}
    },

    saveLocalCache() {
      try {
        localStorage.setItem('trove_playlists_cache', JSON.stringify(this.playlists));
      } catch (_) {}
    },

    getWorkerUrl() {
      const endpoint = CONFIG.getWorkerEndpoint ? CONFIG.getWorkerEndpoint('/playlists') : null;
      if (endpoint) return endpoint;
      return (
        localStorage.getItem(storage.workerPlaylistsUrlKey) ||
        localStorage.getItem(storage.workerBaseUrlKey) ||
        ''
      );
    },

    getAuthHeaders() {
      const workerToken = localStorage.getItem(storage.workerTokenKey) || '';
      const h = { 'Content-Type': 'application/json' };
      if (workerToken) {
        h['Authorization'] = `Bearer ${workerToken}`;
        h['X-API-Key'] = workerToken;
      }
      return h;
    },

    syncQueueToD1() {
      // Debounce saving explicit user queue to D1 (1.5s)
      clearTimeout(this.pendingSyncTimer);
      this.pendingSyncTimer = setTimeout(() => {
        const queue = this.getQueue();
        this.syncPlaylistToD1('_queue', 'Active Queue', queue);
      }, 1500);
    },

    syncFavoritesToD1() {
      // Debounce saving liked songs to D1 (2s)
      clearTimeout(this.pendingFavsSyncTimer);
      this.pendingFavsSyncTimer = setTimeout(() => {
        const favTracks = this.getFavoriteTracks();
        this.syncPlaylistToD1('_favorites', 'Liked Songs', favTracks);
      }, 2000);
    },

    async syncPlaylistToD1(id, customName = null, customItems = null) {
      const workerUrl = this.getWorkerUrl();
      if (!workerUrl) return;

      const pl = this.playlists.find(p => p.id === id);
      const name = customName || (pl ? pl.name : id);
      const items = customItems || (pl ? pl.items : []);

      try {
        const cleanBase = workerUrl.replace(/\/+$/, '');
        const targetUrl = cleanBase.endsWith('/playlists') ? `${cleanBase}/${encodeURIComponent(id)}` : `${cleanBase}/playlists/${encodeURIComponent(id)}`;
        const res = await fetch(targetUrl, {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify({ id, name, items })
        });
        if (res.ok) {
          if (this.elements.syncBadge) {
            this.elements.syncBadge.innerText = 'D1 Synced';
            this.elements.syncBadge.className = 'px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold bg-emerald-500/10 text-emerald-800 dark:text-emerald-300';
          }
        }
      } catch (err) {
        console.warn('D1 playlist sync notice:', err);
      }
    },

    async fetchFromD1() {
      const workerUrl = this.getWorkerUrl();
      if (!workerUrl) return;

      try {
        const cleanBase = workerUrl.replace(/\/+$/, '');
        const targetUrl = cleanBase.endsWith('/playlists') ? cleanBase : `${cleanBase}/playlists`;
        const res = await fetch(targetUrl, {
          headers: this.getAuthHeaders()
        });

        if (res.ok) {
          const json = await res.json();
          if (json && json.success && Array.isArray(json.playlists)) {
            // Reconcile custom playlists
            const serverPlaylists = json.playlists.filter(p => p.id !== '_queue' && p.id !== '_favorites');
            if (serverPlaylists.length > 0) {
              this.playlists = serverPlaylists;
              this.saveLocalCache();
            }

            // Reconcile active user queue if present
            const serverQueue = json.playlists.find(p => p.id === '_queue');
            if (serverQueue && Array.isArray(serverQueue.items)) {
              const localQueue = this.getQueue();
              if (localQueue.length === 0 && serverQueue.items.length > 0) {
                this.saveStoredQueue(serverQueue.items);
                this.updateQueueCounterUI();
              }
            }

            // Reconcile liked songs from D1 if local is empty
            const serverFavs = json.playlists.find(p => p.id === '_favorites');
            if (serverFavs && Array.isArray(serverFavs.items) && serverFavs.items.length > 0) {
              const localFavs = window.Trove.utils?.getFavorites ? window.Trove.utils.getFavorites() : [];
              if (localFavs.length === 0) {
                const paths = serverFavs.items.map(it => (typeof it === 'string' ? it : it.path)).filter(Boolean);
                if (paths.length > 0) {
                  localStorage.setItem('trove_favorites', JSON.stringify(paths));
                  window.dispatchEvent(new CustomEvent('trove:favorites-changed', {
                    detail: { favorites: paths }
                  }));
                }
              }
            }

            if (this.elements.syncBadge) {
              this.elements.syncBadge.innerText = 'D1 Synced';
              this.elements.syncBadge.className = 'px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold bg-emerald-500/10 text-emerald-800 dark:text-emerald-300';
            }

            if (this.isOpen) {
              if (this.activeTab === 'queue') this.renderQueue();
              else this.renderPlaylists();
            }
          }
        }
      } catch (err) {
        console.warn('D1 fetch notice:', err);
      }
    },

    async backupToHuggingFace() {
      const state = window.Trove.state || {};
      const repo = CONFIG.repo || {};
      const token = state.token || (CONFIG.storage?.tokenKey && localStorage.getItem(CONFIG.storage.tokenKey)) || localStorage.getItem('trove_hf_token');
      if (!token) {
        if (showToast) showToast('Hugging Face token required to backup');
        return;
      }

      const repoId = (
        (CONFIG.storage?.hfRepoKey && localStorage.getItem(CONFIG.storage.hfRepoKey)) ||
        repo.id ||
        'mnswa/trove_dataset'
      ).trim();

      const btn = this.elements.btnBackupHf;
      let origHtml = null;
      if (btn) {
        origHtml = btn.innerHTML;
        btn.disabled = true;
        btn.classList.add('opacity-75', 'pointer-events-none');
        btn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Syncing...</span>';
        if (window.lucide) window.lucide.createIcons();
      }

      if (showToast) showToast('Syncing playlists & liked songs to Hugging Face...');

      try {
        const favPaths = window.Trove.utils?.getFavorites
          ? window.Trove.utils.getFavorites()
          : (() => {
              try { return JSON.parse(localStorage.getItem('trove_favorites') || '[]'); } catch (_) { return []; }
            })();

        const favTracks = this.getFavoriteTracks();
        const userPlaylists = this.playlists.filter(p => p.id !== '_queue' && p.id !== '_favorites');

        // Create standard smart playlist entry for Liked Songs
        const likedPlaylistEntry = {
          id: '_favorites',
          name: 'Liked Songs',
          items: favTracks,
          updatedAt: Date.now()
        };

        const snapshot = {
          version: 2,
          updatedAt: new Date().toISOString(),
          playlists: [likedPlaylistEntry, ...userPlaylists],
          favorites: favPaths,
          likedTracks: favTracks,
          activeQueue: this.getStoredQueue() || []
        };

        const jsonStr = JSON.stringify(snapshot, null, 2);
        let encodedContent;
        try {
          const bytes = new TextEncoder().encode(jsonStr);
          let binary = '';
          for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          encodedContent = btoa(binary);
        } catch (_) {
          encodedContent = btoa(unescape(encodeURIComponent(jsonStr)));
        }

        const filePath = 'metadata/playlists.json';

        // Hugging Face Hub Commit API requires application/x-ndjson
        const headerLine = JSON.stringify({
          key: 'header',
          value: {
            summary: 'Backup custom playlists, liked songs, and queue',
            description: `Trove snapshot with ${userPlaylists.length} custom playlists and ${favPaths.length} liked tracks`
          }
        });
        const fileLine = JSON.stringify({
          key: 'file',
          value: {
            path: filePath,
            content: encodedContent,
            encoding: 'base64'
          }
        });
        const ndjsonBody = `${headerLine}\n${fileLine}\n`;

        const branch = repo.branch || 'main';
        const candidateEndpoints = [
          `https://huggingface.co/api/datasets/${repoId}/commit/${encodeURIComponent(branch)}`,
          `https://huggingface.co/api/datasets/${repoId}/commit/main`,
          `https://huggingface.co/api/datasets/${repoId}/commit/master`,
          `https://huggingface.co/api/models/${repoId}/commit/${encodeURIComponent(branch)}`,
          `https://huggingface.co/api/models/${repoId}/commit/main`
        ].filter((u, idx, arr) => arr.indexOf(u) === idx);

        let commitSuccess = false;
        let lastError = null;

        for (const commitUrl of candidateEndpoints) {
          try {
            const res = await fetch(commitUrl, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/x-ndjson'
              },
              body: ndjsonBody
            });

            if (res.ok) {
              commitSuccess = true;
              break;
            } else if (res.status === 401 || res.status === 403) {
              throw new Error(`HF returned ${res.status}: Token lacks write permissions`);
            } else if (res.status === 404) {
              lastError = new Error(`Commit route not found (404) on ${commitUrl}`);
              continue;
            } else {
              const errText = await res.text().catch(() => '');
              throw new Error(`HF responded with HTTP ${res.status}: ${errText.slice(0, 100)}`);
            }
          } catch (e) {
            if (e.message && e.message.includes('Token lacks write permissions')) {
              throw e;
            }
            lastError = e;
          }
        }

        // Direct raw PUT upload fallback if commit endpoints return 404
        if (!commitSuccess) {
          const rawUploadUrls = [
            `https://huggingface.co/api/datasets/${repoId}/upload/main/${filePath}`,
            `https://huggingface.co/api/buckets/${repoId}/raw/${filePath}`
          ];
          for (const rawUrl of rawUploadUrls) {
            try {
              const rawRes = await fetch(rawUrl, {
                method: 'PUT',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json'
                },
                body: jsonStr
              });
              if (rawRes.ok) {
                commitSuccess = true;
                break;
              }
            } catch (_) {}
          }
        }

        if (commitSuccess) {
          if (showToast) showToast(`Playlists & ${favPaths.length} liked songs synced to HF!`);
        } else {
          throw lastError || new Error('Could not commit playlists to Hugging Face');
        }
      } catch (err) {
        console.error('Backup error:', err);
        if (showToast) showToast(`Sync failed: ${err.message}`);
      } finally {
        if (btn && origHtml !== null) {
          btn.disabled = false;
          btn.classList.remove('opacity-75', 'pointer-events-none');
          btn.innerHTML = origHtml;
          if (window.lucide) window.lucide.createIcons();
        }
      }
    },

    async restoreFromHuggingFace(silent = false) {
      const state = window.Trove.state || {};
      const repo = CONFIG.repo || {};
      const token = state.token || (CONFIG.storage?.tokenKey && localStorage.getItem(CONFIG.storage.tokenKey)) || localStorage.getItem('trove_hf_token');
      const repoId = (
        (CONFIG.storage?.hfRepoKey && localStorage.getItem(CONFIG.storage.hfRepoKey)) ||
        repo.id ||
        'mnswa/trove_dataset'
      ).trim();
      const branch = repo.branch || 'main';

      const btn = this.elements.btnRestoreHf;
      let origHtml = null;
      if (btn && !silent) {
        origHtml = btn.innerHTML;
        btn.disabled = true;
        btn.classList.add('opacity-75', 'pointer-events-none');
        btn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Restoring...</span>';
        if (window.lucide) window.lucide.createIcons();
      }

      if (!silent && showToast) showToast('Restoring playlists from Hugging Face...');

      const candidateUrls = [
        `https://huggingface.co/api/buckets/${repoId}/raw/metadata/playlists.json`,
        `https://huggingface.co/buckets/${repoId}/raw/metadata/playlists.json`,
        `https://huggingface.co/buckets/${repoId}/resolve/metadata/playlists.json`,
        `https://huggingface.co/datasets/${repoId}/raw/${branch}/metadata/playlists.json`,
        `https://huggingface.co/datasets/${repoId}/resolve/${branch}/metadata/playlists.json`,
        `https://huggingface.co/datasets/${repoId}/raw/main/metadata/playlists.json`,
        `https://huggingface.co/datasets/${repoId}/raw/master/metadata/playlists.json`
      ];

      let snapshot = null;
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

      for (const url of candidateUrls) {
        try {
          const res = await fetch(url, { headers });
          if (res.ok) {
            snapshot = await res.json();
            if (snapshot && (Array.isArray(snapshot.playlists) || Array.isArray(snapshot.favorites))) {
              break;
            }
          }
        } catch (_) {}
      }

      try {
        if (!snapshot) {
          if (!silent && showToast) showToast('No remote playlist backup found on Hugging Face');
          return false;
        }

        // 1. Restore Custom Playlists
        if (Array.isArray(snapshot.playlists)) {
          const validPlaylists = snapshot.playlists.filter(p => p.id !== '_queue' && p.id !== '_favorites');
          if (validPlaylists.length > 0) {
            if (this.playlists.length === 0) {
              this.playlists = validPlaylists;
            } else {
              const existingIds = new Set(this.playlists.map(p => p.id));
              for (const pl of validPlaylists) {
                if (!existingIds.has(pl.id)) {
                  this.playlists.push(pl);
                }
              }
            }
            this.saveLocalCache();
          }
        }

        // 2. Restore Liked Songs / Favorites
        let favPaths = [];
        if (Array.isArray(snapshot.favorites)) {
          favPaths = snapshot.favorites.map(it => (typeof it === 'string' ? it : it?.path)).filter(Boolean);
        } else if (Array.isArray(snapshot.likedTracks)) {
          favPaths = snapshot.likedTracks.map(it => (typeof it === 'string' ? it : it?.path)).filter(Boolean);
        } else if (Array.isArray(snapshot.playlists)) {
          const favPl = snapshot.playlists.find(p => p.id === '_favorites');
          if (favPl && Array.isArray(favPl.items)) {
            favPaths = favPl.items.map(it => (typeof it === 'string' ? it : it?.path)).filter(Boolean);
          }
        }

        if (favPaths.length > 0) {
          const localFavs = window.Trove.utils?.getFavorites ? window.Trove.utils.getFavorites() : [];
          const mergedFavs = Array.from(new Set([...localFavs, ...favPaths]));
          localStorage.setItem('trove_favorites', JSON.stringify(mergedFavs));
          window.dispatchEvent(new CustomEvent('trove:favorites-changed', {
            detail: { favorites: mergedFavs }
          }));
        }

        // 3. Restore active queue if local queue is empty
        if (Array.isArray(snapshot.activeQueue) && snapshot.activeQueue.length > 0) {
          const localQueue = this.getQueue();
          if (localQueue.length === 0) {
            this.saveStoredQueue(snapshot.activeQueue);
            this.updateQueueCounterUI();
          }
        }

        if (this.isOpen) {
          if (this.activeTab === 'queue') this.renderQueue();
          else this.renderPlaylists();
        }

        if (!silent && showToast) {
          showToast(`Playlists & Liked Songs restored from HF! (${this.playlists.length} playlists, ${favPaths.length} liked)`);
        }
        return true;
      } catch (err) {
        console.error('Restore error:', err);
        if (!silent && showToast) showToast(`Restore error: ${err.message}`);
        return false;
      } finally {
        if (btn && origHtml !== null) {
          btn.disabled = false;
          btn.classList.remove('opacity-75', 'pointer-events-none');
          btn.innerHTML = origHtml;
          if (window.lucide) window.lucide.createIcons();
        }
      }
    }
  };

  // Export
  window.Trove.playlists = PlaylistsManager;
})();

