/**
 * Trove Media Vault - Live Recommendations Manager
 * Cloudflare Worker InnerTube Integration, track selection, and background download dispatch.
 */
(function() {
  window.Trove = window.Trove || {};

  const CONFIG = window.APP_CONFIG || {};
  const repo = CONFIG.repo || {};
  const api = CONFIG.api || {};
  const storage = CONFIG.storage || {};
  const { MotionAnim, showToast, escapeHtml } = window.Trove.utils || {};

  const safeEscape = (str) => {
    if (escapeHtml) return escapeHtml(str);
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  const RelatedManager = {
    isOpen: false,
    currentTrackPath: null,
    currentVideoId: null,
    cache: new Map(), // track.path -> { videoId, videos: [], playlists: [], sourceTitle }
    selectedVideos: new Map(), // videoId -> video object
    allVideos: [],
    allPlaylists: [],
    playlistTracksCache: new Map(), // playlistId -> tracks array
    playlistTracksLoading: new Set(), // playlistId
    isLoading: false,
    continuationToken: null,
    isLoadingMore: false,
    currentView: 'tracks', // 'tracks' | 'playlists' | 'playlist-detail'
    activePlaylist: null,
    elements: {},

    init() {
      this.elements = {
        btnToggle: document.getElementById('btn-related-toggle'),
        bottomSheet: document.getElementById('related-bottom-sheet'),
        backdrop: document.getElementById('related-backdrop'),
        btnClose: document.getElementById('btn-close-related'),
        btnRefresh: document.getElementById('btn-related-refresh'),
        btnSettings: document.getElementById('btn-related-settings'),
        countBadge: document.getElementById('related-count-badge'),
        sourceTitle: document.getElementById('related-source-title'),
        toolbar: document.getElementById('related-toolbar'),
        toolbarLeft: document.getElementById('related-toolbar-left'),
        selectAll: document.getElementById('related-select-all'),
        selectAllLabel: document.getElementById('related-select-all-label'),
        selectedSummary: document.getElementById('related-selected-summary'),
        viewTabs: document.getElementById('related-view-tabs'),
        tabTracks: document.getElementById('tab-recs-tracks'),
        tabPlaylists: document.getElementById('tab-recs-playlists'),
        listContainer: document.getElementById('related-list-container'),
        loadingState: document.getElementById('related-loading-state'),
        emptyState: document.getElementById('related-empty-state'),
        emptyText: document.getElementById('related-empty-text'),
        emptySubtext: document.getElementById('related-empty-subtext'),
        btnEmptyOpenSettings: document.getElementById('btn-empty-open-settings'),
        footerStatus: document.getElementById('related-footer-status'),
        btnDownloadSelected: document.getElementById('btn-download-selected'),
        btnDownloadSelectedLabel: document.getElementById('btn-download-selected-label')
      };

      this.setupEventListeners();
    },

    setupEventListeners() {
      if (this.elements.btnToggle) {
        this.elements.btnToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          this.open();
        });
      }
      if (this.elements.bottomSheet) {
        this.elements.bottomSheet.addEventListener('click', (e) => {
          const card = this.elements.bottomSheet.querySelector('.relative');
          if (card && !card.contains(e.target)) {
            this.close();
          }
        });
      }
      if (this.elements.backdrop) {
        this.elements.backdrop.addEventListener('click', () => this.close());
      }
      if (this.elements.btnClose) {
        this.elements.btnClose.addEventListener('click', () => this.close());
      }
      if (this.elements.btnRefresh) {
        this.elements.btnRefresh.addEventListener('click', () => {
          this.fetchRecommendations(true);
        });
      }
      if (this.elements.btnSettings) {
        this.elements.btnSettings.addEventListener('click', () => {
          if (window.Trove.settings) window.Trove.settings.open();
        });
      }
      if (this.elements.btnEmptyOpenSettings) {
        this.elements.btnEmptyOpenSettings.addEventListener('click', () => {
          if (window.Trove.settings) window.Trove.settings.open();
        });
      }
      if (this.elements.selectAll) {
        this.elements.selectAll.addEventListener('change', (e) => {
          this.handleSelectAll(e.target.checked);
        });
      }
      if (this.elements.tabTracks) {
        this.elements.tabTracks.addEventListener('click', () => {
          this.switchView('tracks');
        });
      }
      if (this.elements.tabPlaylists) {
        this.elements.tabPlaylists.addEventListener('click', () => {
          this.switchView('playlists');
        });
      }
      if (this.elements.btnDownloadSelected) {
        this.elements.btnDownloadSelected.addEventListener('click', () => {
          this.downloadSelected();
        });
      }
    },

    open() {
      if (!this.elements.bottomSheet) return;
      this.isOpen = true;
      this.elements.bottomSheet.style.display = 'flex';

      // Temporarily suppress expanded cover art to eliminate GPU compositor bleed
      const coverArt = document.getElementById('expanded-cover-art');
      if (coverArt) {
        this._prevCoverVisibility = coverArt.style.visibility;
        coverArt.style.visibility = 'hidden';
      }

      if (MotionAnim) MotionAnim.animateSheetIn(this.elements.bottomSheet);

      const player = window.Trove.player || {};
      const track = player.currentTrack;
      if (!track) {
        this.renderEmpty('No Track Playing', 'Play a track in Trove to see live recommendations.');
        return;
      }

      if (this.currentTrackPath === track.path && this.cache.has(track.path)) {
        const cached = this.cache.get(track.path);
        this.currentVideoId = cached.videoId;
        this.continuationToken = cached.continuationToken || null;
        this.allVideos = [...(cached.videos || [])];
        this.allPlaylists = [...(cached.playlists || [])];
        this.renderContent(cached.videos, cached.playlists, cached.sourceTitle);
      } else {
        this.fetchRecommendations(false);
      }
    },

    close() {
      if (!this.elements.bottomSheet || this.elements.bottomSheet.style.display === 'none') return;
      this.isOpen = false;

      // Restore expanded cover art visibility
      const coverArt = document.getElementById('expanded-cover-art');
      if (coverArt) {
        coverArt.style.visibility = this._prevCoverVisibility || '';
      }

      if (MotionAnim) {
        MotionAnim.animateSheetOut(this.elements.bottomSheet, () => {
          this.elements.bottomSheet.style.display = 'none';
        });
      } else {
        this.elements.bottomSheet.style.display = 'none';
      }
    },

    async resolveVideoId(track) {
      if (!track) return null;
      if (track._videoId) return track._videoId;

      const player = window.Trove.player || {};
      const state = window.Trove.state || {};

      const thumb = player.thumbnailCache?.get(track.path);
      if (thumb && typeof thumb === 'string') {
        const m = thumb.match(/(?:ytimg\.com\/vi\/|youtube\.com\/vi\/)([A-Za-z0-9_-]{11})/);
        if (m) {
          track._videoId = m[1];
          return m[1];
        }
      }

      const nameMatch = track.name.match(/\[([A-Za-z0-9_-]{11})\]/) || track.name.match(/(?:-|_|\s)([A-Za-z0-9_-]{11})(?:\.[a-zA-Z0-9]+)?$/);
      if (nameMatch) {
        track._videoId = nameMatch[1];
        return nameMatch[1];
      }

      try {
        const baseName = track.name.replace(/\.[a-zA-Z0-9]+$/, '');
        const encodedName = encodeURIComponent(baseName + '.json');
        const isBucket = repo.isBucket !== false;
        const candidateUrls = isBucket ? [
          `https://huggingface.co/buckets/${repo.id}/resolve/metadata/${encodedName}`,
          `https://huggingface.co/buckets/${repo.id}/raw/metadata/${encodedName}`,
          `${api.bucketsBase}/${repo.id}/resolve/metadata/${encodedName}`
        ] : [
          `https://huggingface.co/datasets/${repo.id}/resolve/${repo.branch || 'main'}/metadata/${encodedName}`,
          `https://huggingface.co/datasets/${repo.id}/raw/${repo.branch || 'main'}/metadata/${encodedName}`
        ];

        for (const u of candidateUrls) {
          try {
            const h = state.token ? { 'Authorization': `Bearer ${state.token}` } : {};
            const r = await fetch(u, { headers: h });
            if (r.ok) {
              const meta = await r.json();
              if (meta) {
                if (meta.id && /^[A-Za-z0-9_-]{11}$/.test(meta.id)) {
                  track._videoId = meta.id;
                  return meta.id;
                }
                if (meta.videoId && /^[A-Za-z0-9_-]{11}$/.test(meta.videoId)) {
                  track._videoId = meta.videoId;
                  return meta.videoId;
                }
                if (meta.webpage_url) {
                  const m2 = meta.webpage_url.match(/(?:v=|youtu\.be\/)([^#&?]{11})/);
                  if (m2) {
                    track._videoId = m2[1];
                    return m2[1];
                  }
                }
                if (meta.thumbnail) {
                  const m3 = meta.thumbnail.match(/(?:ytimg\.com\/vi\/|youtube\.com\/vi\/)([A-Za-z0-9_-]{11})/);
                  if (m3) {
                    track._videoId = m3[1];
                    return m3[1];
                  }
                }
              }
            }
          } catch (_) {}
        }
      } catch (_) {}

      return null;
    },

    async fetchRecommendations(forceFresh = false) {
      const player = window.Trove.player || {};
      const track = player.currentTrack;
      if (!track) {
        this.renderEmpty('No Track Playing', 'Play a track in Trove to see recommendations.');
        return;
      }

      const workerUrl = (CONFIG.getWorkerEndpoint ? CONFIG.getWorkerEndpoint('/recommendations') : null) || localStorage.getItem(storage.workerRecsUrlKey) || '';
      const workerToken = localStorage.getItem(storage.workerTokenKey) || '';

      if (!workerUrl) {
        this.renderEmpty('Cloudflare Worker Needed', 'Please configure your Trove Worker URL in Settings.');
        if (this.elements.btnEmptyOpenSettings) this.elements.btnEmptyOpenSettings.classList.remove('hidden');
        return;
      }

      this.currentTrackPath = track.path;
      this.selectedVideos.clear();
      this.updateSelectionUI();

      const cleanTitle = track.name.replace(/\.[a-zA-Z0-9]+$/, '').replace(/\[.*?\]/g, '').trim();
      if (this.elements.sourceTitle) {
        this.elements.sourceTitle.innerText = `Based on: ${cleanTitle}`;
      }

      if (!forceFresh && this.cache.has(track.path)) {
        const cached = this.cache.get(track.path);
        this.currentVideoId = cached.videoId;
        this.continuationToken = cached.continuationToken || null;
        this.allVideos = [...(cached.videos || [])];
        this.allPlaylists = [...(cached.playlists || [])];
        this.renderContent(cached.videos, cached.playlists, cleanTitle);
        return;
      }

      this.setLoading(true);

      try {
        const videoId = await this.resolveVideoId(track);
        if (!videoId) {
          this.setLoading(false);
          this.renderEmpty(
            'No YouTube ID Found',
            `Could not resolve a YouTube video ID for "${cleanTitle}". Tracks imported via the Ingest tool contain YouTube IDs.`
          );
          return;
        }

        this.currentVideoId = videoId;

        const cleanBase = workerUrl.replace(/\/+$/, '');
        const sep = cleanBase.includes('?') ? '&' : (cleanBase.endsWith('/recommendations') ? '?' : '/?');
        let targetUrl = `${cleanBase}${sep}videoId=${encodeURIComponent(videoId)}&excludeShorts=true`;
        if (workerToken) {
          targetUrl += `&token=${encodeURIComponent(workerToken)}`;
        }
        if (forceFresh) {
          targetUrl += '&fresh=1';
        }

        const headers = { 'Accept': 'application/json' };
        if (workerToken) {
          headers['Authorization'] = `Bearer ${workerToken}`;
          headers['X-API-Key'] = workerToken;
        }

        const res = await fetch(targetUrl, { headers });
        if (!res.ok) {
          let errText = `Worker returned status ${res.status}`;
          try {
            const errData = await res.json();
            errText = errData.error || errText;
          } catch (_) {}
          throw new Error(errText);
        }

        const data = await res.json();
        const videos = Array.isArray(data.videos) ? data.videos : [];
        const playlists = Array.isArray(data.playlists) ? data.playlists : [];
        this.continuationToken = data.continuation_token || null;
        this.allVideos = [...videos];
        this.allPlaylists = [...playlists];

        this.cache.set(track.path, {
          videoId,
          videos,
          playlists,
          continuationToken: this.continuationToken,
          sourceTitle: cleanTitle
        });
        this.setLoading(false);
        this.renderContent(videos, playlists, cleanTitle);

      } catch (err) {
        console.error('Recommendations fetch error:', err);
        this.setLoading(false);
        this.renderEmpty(
          'Failed to load recommendations',
          err.message || 'Check your Cloudflare Worker URL, network connection, or API token.'
        );
      }
    },

    async fetchPlaylistTracks(playlistId) {
      if (!playlistId) return [];
      if (this.playlistTracksCache.has(playlistId)) {
        return this.playlistTracksCache.get(playlistId);
      }

      const storage = CONFIG.storage || {};
      const workerUrl = (CONFIG.getWorkerEndpoint ? CONFIG.getWorkerEndpoint('/recommendations') : null) || localStorage.getItem(storage.workerRecsUrlKey) || '';
      const workerToken = localStorage.getItem(storage.workerTokenKey) || '';

      if (!workerUrl) {
        if (showToast) showToast('Cloudflare Worker URL required');
        return [];
      }

      this.playlistTracksLoading.add(playlistId);
      try {
        const cleanBase = workerUrl.replace(/\/+$/, '');
        const sep = cleanBase.includes('?') ? '&' : (cleanBase.endsWith('/recommendations') ? '?' : '/?');
        let targetUrl = `${cleanBase}${sep}playlistId=${encodeURIComponent(playlistId)}`;
        if (workerToken) {
          targetUrl += `&token=${encodeURIComponent(workerToken)}`;
        }

        const headers = { 'Accept': 'application/json' };
        if (workerToken) {
          headers['Authorization'] = `Bearer ${workerToken}`;
          headers['X-API-Key'] = workerToken;
        }

        const res = await fetch(targetUrl, { headers });
        if (!res.ok) {
          throw new Error(`Worker returned status ${res.status}`);
        }

        const data = await res.json();
        const tracks = Array.isArray(data.tracks) ? data.tracks : [];
        this.playlistTracksCache.set(playlistId, tracks);
        return tracks;
      } catch (err) {
        console.error(`Failed to fetch playlist tracks for ${playlistId}:`, err);
        if (showToast) showToast('Could not load playlist tracks.');
        return [];
      } finally {
        this.playlistTracksLoading.delete(playlistId);
      }
    },

    setLoading(loading) {
      this.isLoading = loading;
      if (this.elements.loadingState) {
        this.elements.loadingState.classList.toggle('hidden', !loading);
      }
      if (this.elements.listContainer) {
        this.elements.listContainer.classList.toggle('hidden', loading);
      }
      if (this.elements.toolbar) {
        this.elements.toolbar.classList.toggle('hidden', loading);
      }
      if (this.elements.emptyState) {
        this.elements.emptyState.classList.add('hidden');
      }
      if (this.elements.btnRefresh) {
        this.elements.btnRefresh.disabled = loading;
        const icon = this.elements.btnRefresh.querySelector('i, svg');
        if (icon) {
          icon.classList.toggle('animate-spin', loading);
        }
      }
    },

    renderEmpty(title, subtext) {
      if (this.elements.loadingState) this.elements.loadingState.classList.add('hidden');
      if (this.elements.toolbar) this.elements.toolbar.classList.add('hidden');
      if (this.elements.listContainer) {
        this.elements.listContainer.innerHTML = '';
        this.elements.listContainer.classList.add('hidden');
      }
      if (this.elements.emptyState) {
        this.elements.emptyState.classList.remove('hidden');
        if (this.elements.emptyText) this.elements.emptyText.innerText = title;
        if (this.elements.emptySubtext) this.elements.emptySubtext.innerText = subtext;
      }
      if (this.elements.countBadge) this.elements.countBadge.innerText = '0 found';
      if (this.elements.footerStatus) this.elements.footerStatus.innerText = 'Idle';
    },

    renderVideos(videos, sourceTitle) {
      this.renderContent(videos, this.allPlaylists || [], sourceTitle);
    },

    renderContent(videos, playlists, sourceTitle) {
      const vids = Array.isArray(videos) ? videos : [];
      // Strictly filter out any invalid, headless or empty playlists
      const pls = (Array.isArray(playlists) ? playlists : []).filter(p => p && p.id && p.title && typeof p.title === 'string' && p.title.trim().length > 0);
      this.allVideos = vids;
      this.allPlaylists = pls;
      const totalItems = vids.length + pls.length;

      if (totalItems === 0) {
        this.renderEmpty('No Recommendations', 'YouTube returned 0 recommendations for this track.');
        return;
      }

      if (this.elements.loadingState) this.elements.loadingState.classList.add('hidden');
      if (this.elements.emptyState) this.elements.emptyState.classList.add('hidden');
      if (this.elements.toolbar) this.elements.toolbar.classList.remove('hidden');
      if (this.elements.listContainer) this.elements.listContainer.classList.remove('hidden');

      this.updateHeaderBadge();
      if (this.elements.footerStatus) {
        this.elements.footerStatus.innerText = `${totalItems} recommendations ready`;
      }

      // Configure Tab Switcher in Toolbar (Only display tabs if real playlists exist)
      if (this.elements.viewTabs) {
        if (pls.length > 0) {
          this.elements.viewTabs.classList.remove('hidden');
          if (this.elements.tabTracks) {
            this.elements.tabTracks.innerText = `Tracks (${vids.length})`;
          }
          if (this.elements.tabPlaylists) {
            this.elements.tabPlaylists.innerText = `Playlists (${pls.length})`;
          }
        } else {
          this.elements.viewTabs.classList.add('hidden');
        }
      }

      // Default view is 'tracks'
      this.switchView('tracks');
    },

    updateHeaderBadge() {
      if (!this.elements.countBadge) return;
      if (this.currentView === 'playlists' || this.currentView === 'playlist-detail') {
        this.elements.countBadge.innerText = `${this.allPlaylists.length} playlists`;
      } else {
        this.elements.countBadge.innerText = `${this.allVideos.length} tracks`;
      }
    },

    switchView(view, playlist = null) {
      this.currentView = view;
      this.activePlaylist = playlist;
      this.updateHeaderBadge();

      // Update Tab Pill styles
      if (this.elements.tabTracks && this.elements.tabPlaylists) {
        const isTracks = (view === 'tracks');
        this.elements.tabTracks.className = isTracks 
          ? 'px-2.5 py-1 rounded-md transition shadow-xs bg-white dark:bg-[#202532] text-jet-black dark:text-[#f3f4f6] cursor-pointer'
          : 'px-2.5 py-1 rounded-md transition text-stone-brown/70 dark:text-[#9aa4b2] hover:text-black dark:hover:text-white cursor-pointer';

        const isPlaylists = (view === 'playlists' || view === 'playlist-detail');
        this.elements.tabPlaylists.className = isPlaylists
          ? 'px-2.5 py-1 rounded-md transition shadow-xs bg-white dark:bg-[#202532] text-jet-black dark:text-[#f3f4f6] cursor-pointer'
          : 'px-2.5 py-1 rounded-md transition text-stone-brown/70 dark:text-[#9aa4b2] hover:text-black dark:hover:text-white cursor-pointer';
      }

      if (view === 'tracks') {
        this.renderTracksView();
      } else if (view === 'playlists') {
        this.renderPlaylistsView();
      } else if (view === 'playlist-detail') {
        this.renderPlaylistDetailView(playlist);
      }
    },

    renderTracksView() {
      if (!this.elements.listContainer) return;
      this.elements.listContainer.innerHTML = '';

      if (this.elements.toolbarLeft) {
        this.elements.toolbarLeft.classList.remove('hidden', 'invisible');
      }
      if (this.elements.selectAllLabel) {
        this.elements.selectAllLabel.innerText = 'Select All';
      }

      if (this.allVideos.length === 0) {
        this.elements.listContainer.innerHTML = `
          <div class="py-12 px-4 text-center text-xs font-mono text-stone-brown/70 dark:text-[#8b95a5]">
            No recommended tracks found.
          </div>
        `;
        this.updateSelectionUI();
        return;
      }

      this.allVideos.forEach(video => {
        const card = this.createVideoCard(video);
        if (card) this.elements.listContainer.appendChild(card);
      });

      if (this.continuationToken) {
        this.appendLoadMoreButton();
      }

      this.updateSelectionUI();
      if (window.lucide) window.lucide.createIcons();
    },

    renderPlaylistsView() {
      if (!this.elements.listContainer) return;
      this.elements.listContainer.innerHTML = '';

      if (this.elements.toolbarLeft) {
        this.elements.toolbarLeft.classList.add('hidden');
      }

      const validPlaylists = (this.allPlaylists || []).filter(p => p && p.id && p.title && typeof p.title === 'string');
      if (validPlaylists.length === 0) {
        this.elements.listContainer.innerHTML = `
          <div class="py-12 px-4 text-center text-xs font-mono text-stone-brown/70 dark:text-[#8b95a5]">
            No related playlists found for this track.
          </div>
        `;
        return;
      }

      validPlaylists.forEach(playlist => {
        const card = this.createPlaylistCard(playlist);
        if (card) {
          this.elements.listContainer.appendChild(card);
        }
      });

      if (window.lucide) window.lucide.createIcons();
    },

    async renderPlaylistDetailView(playlist) {
      if (!this.elements.listContainer || !playlist) return;
      this.elements.listContainer.innerHTML = '';

      if (this.elements.toolbarLeft) {
        this.elements.toolbarLeft.classList.remove('invisible');
      }
      if (this.elements.selectAllLabel) {
        this.elements.selectAllLabel.innerText = 'Select All';
      }

      // Breadcrumb Header inside list container
      const navHeader = document.createElement('div');
      navHeader.className = 'p-2 sm:p-2.5 mb-2 bg-almond-cream/40 dark:bg-[#1a1e27] rounded-xl border border-almond-cream dark:border-[#272f3d] flex items-center justify-between gap-2 select-none';
      const titleEscaped = safeEscape(playlist.title || 'Untitled Playlist');

      navHeader.innerHTML = `
        <button type="button" id="btn-back-to-playlists" class="inline-flex items-center gap-1.5 text-xs font-semibold text-accent-brown dark:text-[#c6ac8f] hover:underline cursor-pointer py-1">
          <i data-lucide="arrow-left" class="w-4 h-4"></i>
          <span>Back to Playlists</span>
        </button>
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-[11px] sm:text-xs font-semibold text-stone-brown dark:text-[#c6ac8f] truncate max-w-[140px] sm:max-w-[240px]" title="${titleEscaped}">
            ${titleEscaped}
          </span>
          <button type="button" id="btn-playlist-detail-dl-all" class="px-2.5 py-1 text-xs font-semibold rounded-lg bg-jet-black text-white dark:bg-[#f3f4f6] dark:text-[#0e1116] flex items-center gap-1 shadow-xs cursor-pointer shrink-0">
            <i data-lucide="download" class="w-3.5 h-3.5"></i>
            <span>Download All</span>
          </button>
        </div>
      `;
      this.elements.listContainer.appendChild(navHeader);

      navHeader.querySelector('#btn-back-to-playlists').addEventListener('click', () => {
        this.switchView('playlists');
      });

      const btnDlAll = navHeader.querySelector('#btn-playlist-detail-dl-all');
      btnDlAll.addEventListener('click', async () => {
        let tracks = this.playlistTracksCache.get(playlist.id);
        if (!tracks || tracks.length === 0) {
          tracks = await this.fetchPlaylistTracks(playlist.id);
        }
        if (tracks && tracks.length > 0) {
          this.downloadTracks(tracks, { triggerBtn: btnDlAll });
        } else {
          if (showToast) showToast('No tracks found to download');
        }
      });

      // Tracks Container
      const tracksContainer = document.createElement('div');
      tracksContainer.className = 'space-y-1';
      this.elements.listContainer.appendChild(tracksContainer);

      let tracks = this.playlistTracksCache.get(playlist.id);
      if (!tracks) {
        tracksContainer.innerHTML = `
          <div class="py-10 flex flex-col items-center justify-center gap-2 text-xs font-mono text-stone-brown/70 dark:text-[#8b95a5]">
            <i data-lucide="loader-2" class="w-5 h-5 animate-spin text-stone-brown dark:text-[#c6ac8f]"></i>
            <span>Loading playlist tracks...</span>
          </div>
        `;
        if (window.lucide) window.lucide.createIcons();
        tracks = await this.fetchPlaylistTracks(playlist.id);
        tracksContainer.innerHTML = '';
      }

      if (!tracks || tracks.length === 0) {
        tracksContainer.innerHTML = `
          <div class="py-8 text-center text-xs font-mono text-stone-brown/60 dark:text-[#758092]">
            No playable tracks found in this playlist.
          </div>
        `;
        if (window.lucide) window.lucide.createIcons();
        return;
      }

      tracks.forEach((track, index) => {
        const trackCard = this.createPlaylistTrackCard(track, playlist, index + 1);
        if (trackCard) tracksContainer.appendChild(trackCard);
      });

      this.updateSelectionUI();
      if (window.lucide) window.lucide.createIcons();
    },

    createVideoCard(video) {
      if (!video || !video.id) return null;
      const card = document.createElement('div');
      card.className = 'p-2 sm:p-2.5 rounded-xl hover:bg-almond-cream/30 dark:hover:bg-[#1e232e] transition flex items-center gap-2.5 sm:gap-3 group select-none relative';

      const thumbUrl = video.thumbnail || (video.thumbnails && video.thumbnails[0]) || (video.id ? `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg` : '');
      const titleEscaped = safeEscape(video.title || 'Untitled Track');
      const channelEscaped = safeEscape(video.channel || 'YouTube');
      const durationText = safeEscape(video.duration || '');
      const viewCountText = safeEscape(video.view_count || video.views || '');
      const isSelected = this.selectedVideos.has(video.id);

      card.innerHTML = `
        <!-- Checkbox -->
        <input type="checkbox" class="related-item-checkbox rounded border-khaki-beige dark:border-[#353c4d] text-jet-black dark:text-[#c6ac8f] shrink-0 cursor-pointer w-4 h-4" data-video-id="${safeEscape(video.id)}" ${isSelected ? 'checked' : ''}>

        <!-- Thumbnail with duration badge -->
        <div class="relative w-16 h-12 sm:w-20 sm:h-14 rounded-lg overflow-hidden bg-almond-cream/40 dark:bg-[#12151c] shrink-0 shadow-sm border border-almond-cream/60 dark:border-[#262c38] flex items-center justify-center">
          ${thumbUrl ? `<img src="${thumbUrl}" alt="" class="w-full h-full object-cover" loading="lazy" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.classList.remove('hidden');">` : ''}
          <div class="${thumbUrl ? 'hidden' : ''} text-stone-brown/40 dark:text-[#525d70]">
            <i data-lucide="music" class="w-5 h-5"></i>
          </div>
          ${durationText ? `<span class="absolute bottom-0.5 right-0.5 px-1 py-0.5 rounded text-[9px] sm:text-[10px] font-mono font-bold bg-black/85 text-white leading-none shadow-sm">${durationText}</span>` : ''}
        </div>

        <!-- Title, Channel & Views (Full width flex) -->
        <div class="card-info flex-1 min-w-0 pr-1 cursor-pointer">
          <div class="text-xs sm:text-sm font-semibold text-black dark:text-[#f3f4f6] truncate group-hover:text-accent-brown dark:group-hover:text-[#c6ac8f] transition" title="${titleEscaped}">
            ${titleEscaped}
          </div>
          <div class="flex items-center gap-1.5 mt-0.5 sm:mt-1 text-[10px] sm:text-[11px] font-mono text-stone-brown/70 dark:text-[#9aa4b2]">
            <span class="truncate max-w-[120px] sm:max-w-[200px]">${channelEscaped}</span>
            ${viewCountText ? `<span class="shrink-0">• ${viewCountText}</span>` : ''}
          </div>
        </div>

        <!-- Direct 1-Tap Action Buttons -->
        <div class="flex items-center gap-1 shrink-0">
          <!-- Play Next Button -->
          <button type="button" class="btn-play-related p-2 rounded-xl text-stone-brown dark:text-[#c6ac8f] hover:text-black dark:hover:text-white hover:bg-almond-cream/60 dark:hover:bg-[#282e3b] transition cursor-pointer" title="Download & Play Next" data-video-id="${safeEscape(video.id)}">
            <i data-lucide="play-circle" class="w-5 h-5 text-accent-brown dark:text-[#c6ac8f]"></i>
          </button>

          <!-- Download Button -->
          <button type="button" class="btn-action-download p-2 rounded-xl text-stone-brown dark:text-[#c6ac8f] hover:text-black dark:hover:text-white hover:bg-almond-cream/60 dark:hover:bg-[#282e3b] transition cursor-pointer" title="Download to Vault" data-video-id="${safeEscape(video.id)}">
            <i data-lucide="download" class="w-4 h-4 sm:w-4.5 sm:h-4.5"></i>
          </button>

          <!-- Open in YouTube External Link -->
          <a href="${safeEscape(video.url || `https://www.youtube.com/watch?v=${video.id}`)}" target="_blank" rel="noopener noreferrer" class="p-2 rounded-xl text-stone-brown/60 dark:text-[#8b95a5] hover:text-black dark:hover:text-white hover:bg-almond-cream/60 dark:hover:bg-[#282e3b] transition hidden sm:inline-flex" title="Open on YouTube">
            <i data-lucide="external-link" class="w-4 h-4"></i>
          </a>
        </div>
      `;

      const cb = card.querySelector('.related-item-checkbox');
      cb.addEventListener('change', (e) => {
        if (e.target.checked) {
          this.selectedVideos.set(video.id, video);
        } else {
          this.selectedVideos.delete(video.id);
        }
        this.updateSelectionUI();
      });

      // Tapping row body toggles checkbox
      const cardInfo = card.querySelector('.card-info');
      cardInfo.addEventListener('click', () => {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });

      const btnPlay = card.querySelector('.btn-play-related');
      if (btnPlay) {
        btnPlay.addEventListener('click', (e) => {
          e.stopPropagation();
          this.downloadAndPlay(video, btnPlay);
        });
      }

      const btnDl = card.querySelector('.btn-action-download');
      if (btnDl) {
        btnDl.addEventListener('click', (e) => {
          e.stopPropagation();
          this.downloadTracks([video], { triggerBtn: btnDl });
        });
      }

      return card;
    },

    createPlaylistCard(playlist) {
      if (!playlist || !playlist.id || !playlist.title || typeof playlist.title !== 'string') return null;

      const card = document.createElement('div');
      card.className = 'p-2 sm:p-2.5 rounded-xl hover:bg-almond-cream/30 dark:hover:bg-[#1e232e] transition flex items-center gap-2.5 sm:gap-3 group select-none relative cursor-pointer';
      card.setAttribute('data-playlist-id', playlist.id);

      const thumbUrl = playlist.thumbnail || (playlist.thumbnails && playlist.thumbnails[0]) || '';
      const titleEscaped = safeEscape(playlist.title || 'Untitled Playlist');
      const channelEscaped = safeEscape(playlist.channel || 'YouTube');
      const videoCountText = safeEscape(playlist.video_count || '');

      card.innerHTML = `
        <!-- Simplified Playlist Thumbnail -->
        <div class="relative w-16 h-12 sm:w-20 sm:h-14 rounded-lg overflow-hidden bg-almond-cream/40 dark:bg-[#12151c] shrink-0 shadow-sm border border-almond-cream/60 dark:border-[#262c38] flex items-center justify-center">
          ${thumbUrl ? `<img src="${thumbUrl}" alt="" class="w-full h-full object-cover" loading="lazy" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.classList.remove('hidden');">` : ''}
          <div class="${thumbUrl ? 'hidden' : ''} text-stone-brown/40 dark:text-[#525d70]">
            <i data-lucide="list-music" class="w-6 h-6"></i>
          </div>
          <!-- Clean playlist count badge on bottom right -->
          <div class="absolute bottom-0.5 right-0.5 px-1 py-0.5 rounded text-[9px] font-mono font-bold bg-black/85 text-white flex items-center gap-0.5 leading-none shadow-sm">
            <i data-lucide="list-music" class="w-2.5 h-2.5"></i>
            ${videoCountText ? `<span>${videoCountText}</span>` : ''}
          </div>
        </div>

        <!-- Title, Channel & Playlist Badge -->
        <div class="card-info flex-1 min-w-0 pr-1">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="px-1.5 py-0.5 text-[9px] font-bold rounded bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/30 uppercase tracking-wider shrink-0">Playlist</span>
            <div class="text-xs sm:text-sm font-semibold text-black dark:text-[#f3f4f6] truncate group-hover:text-accent-brown dark:group-hover:text-[#c6ac8f] transition" title="${titleEscaped}">
              ${titleEscaped}
            </div>
          </div>
          <div class="flex items-center gap-1.5 mt-0.5 sm:mt-1 text-[10px] sm:text-[11px] font-mono text-stone-brown/70 dark:text-[#9aa4b2]">
            <span class="truncate max-w-[130px] sm:max-w-[220px]">${channelEscaped}</span>
          </div>
        </div>

        <!-- Direct Action Buttons -->
        <div class="flex items-center gap-1 shrink-0">
          <!-- View Tracks Button -->
          <button type="button" class="btn-view-playlist px-2.5 py-1.5 rounded-lg bg-almond-cream/60 dark:bg-[#222734] hover:bg-almond-cream dark:hover:bg-[#2d3444] text-xs font-semibold text-black dark:text-[#f3f4f6] transition flex items-center gap-1 cursor-pointer shadow-xs" title="View Tracks">
            <i data-lucide="list-music" class="w-3.5 h-3.5"></i>
            <span class="hidden sm:inline">Tracks</span>
          </button>

          <!-- Download Entire Playlist Button -->
          <button type="button" class="btn-playlist-dl p-2 rounded-xl text-stone-brown dark:text-[#c6ac8f] hover:text-black dark:hover:text-white hover:bg-almond-cream/60 dark:hover:bg-[#282e3b] transition cursor-pointer" title="Download all tracks in playlist">
            <i data-lucide="download" class="w-4 h-4"></i>
          </button>

          <!-- Open in YouTube External Link -->
          <a href="${safeEscape(playlist.url || `https://www.youtube.com/playlist?list=${playlist.id}`)}" target="_blank" rel="noopener noreferrer" class="p-2 rounded-xl text-stone-brown/60 dark:text-[#8b95a5] hover:text-black dark:hover:text-white hover:bg-almond-cream/60 dark:hover:bg-[#282e3b] transition hidden sm:inline-flex" title="Open on YouTube">
            <i data-lucide="external-link" class="w-4 h-4"></i>
          </a>
        </div>
      `;

      // Clicking card or View Tracks button opens playlist details
      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-playlist-dl') || e.target.closest('a')) {
          return;
        }
        this.switchView('playlist-detail', playlist);
      });

      const btnDl = card.querySelector('.btn-playlist-dl');
      btnDl.addEventListener('click', async (e) => {
        e.stopPropagation();
        let tracks = this.playlistTracksCache.get(playlist.id);
        if (!tracks || tracks.length === 0) {
          tracks = await this.fetchPlaylistTracks(playlist.id);
        }
        if (tracks && tracks.length > 0) {
          this.downloadTracks(tracks, { triggerBtn: btnDl });
        } else {
          if (showToast) showToast('No tracks found to download');
        }
      });

      return card;
    },

    createPlaylistTrackCard(track, playlist, trackNumber) {
      if (!track || !track.id) return null;
      const card = document.createElement('div');
      card.className = 'p-1.5 sm:p-2 rounded-lg hover:bg-almond-cream/30 dark:hover:bg-[#1e232e] transition flex items-center gap-2 sm:gap-2.5 group select-none relative';

      const thumbUrl = track.thumbnail || (track.thumbnails && track.thumbnails[0]) || (track.id ? `https://i.ytimg.com/vi/${track.id}/hqdefault.jpg` : '');
      const titleEscaped = safeEscape(track.title || 'Untitled Track');
      const channelEscaped = safeEscape(track.channel || playlist.channel || 'YouTube');
      const durationText = safeEscape(track.duration || '');
      const isSelected = this.selectedVideos.has(track.id);

      card.innerHTML = `
        <!-- Sub-track Checkbox -->
        <input type="checkbox" class="related-item-checkbox playlist-track-checkbox rounded border-khaki-beige dark:border-[#353c4d] text-jet-black dark:text-[#c6ac8f] shrink-0 cursor-pointer w-3.5 h-3.5" data-video-id="${safeEscape(track.id)}" ${isSelected ? 'checked' : ''}>

        <!-- Index Number -->
        <span class="w-4 text-center font-mono text-[10px] text-stone-brown/60 dark:text-[#758092] shrink-0">${trackNumber}</span>

        <!-- Compact Thumbnail with duration -->
        <div class="relative w-12 h-9 sm:w-14 sm:h-10 rounded-md overflow-hidden bg-almond-cream/40 dark:bg-[#12151c] shrink-0 shadow-xs border border-almond-cream/60 dark:border-[#262c38] flex items-center justify-center">
          ${thumbUrl ? `<img src="${thumbUrl}" alt="" class="w-full h-full object-cover" loading="lazy" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.classList.remove('hidden');">` : ''}
          <div class="${thumbUrl ? 'hidden' : ''} text-stone-brown/40 dark:text-[#525d70]">
            <i data-lucide="music" class="w-4 h-4"></i>
          </div>
          ${durationText ? `<span class="absolute bottom-0.5 right-0.5 px-0.5 py-0.2 rounded text-[8px] font-mono font-bold bg-black/85 text-white leading-none">${durationText}</span>` : ''}
        </div>

        <!-- Title & Channel -->
        <div class="card-info flex-1 min-w-0 pr-1 cursor-pointer">
          <div class="text-xs font-semibold text-black dark:text-[#f3f4f6] truncate group-hover:text-accent-brown dark:group-hover:text-[#c6ac8f] transition" title="${titleEscaped}">
            ${titleEscaped}
          </div>
          <div class="flex items-center gap-1 text-[10px] font-mono text-stone-brown/70 dark:text-[#9aa4b2]">
            <span class="truncate max-w-[120px] sm:max-w-[200px]">${channelEscaped}</span>
          </div>
        </div>

        <!-- Direct Action Buttons -->
        <div class="flex items-center gap-0.5 shrink-0">
          <!-- Play Next -->
          <button type="button" class="btn-play-related p-1.5 rounded-lg text-stone-brown dark:text-[#c6ac8f] hover:text-black dark:hover:text-white hover:bg-almond-cream/60 dark:hover:bg-[#282e3b] transition cursor-pointer" title="Download & Play Next" data-video-id="${safeEscape(track.id)}">
            <i data-lucide="play-circle" class="w-4.5 h-4.5 text-accent-brown dark:text-[#c6ac8f]"></i>
          </button>

          <!-- Download -->
          <button type="button" class="btn-action-download p-1.5 rounded-lg text-stone-brown dark:text-[#c6ac8f] hover:text-black dark:hover:text-white hover:bg-almond-cream/60 dark:hover:bg-[#282e3b] transition cursor-pointer" title="Download to Vault" data-video-id="${safeEscape(track.id)}">
            <i data-lucide="download" class="w-4 h-4"></i>
          </button>

          <!-- Open in YouTube -->
          <a href="${safeEscape(track.url || `https://www.youtube.com/watch?v=${track.id}`)}" target="_blank" rel="noopener noreferrer" class="p-1.5 rounded-lg text-stone-brown/60 dark:text-[#8b95a5] hover:text-black dark:hover:text-white hover:bg-almond-cream/60 dark:hover:bg-[#282e3b] transition hidden sm:inline-flex" title="Open on YouTube">
            <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
          </a>
        </div>
      `;

      const cb = card.querySelector('.playlist-track-checkbox');
      cb.addEventListener('change', (e) => {
        if (e.target.checked) {
          this.selectedVideos.set(track.id, track);
        } else {
          this.selectedVideos.delete(track.id);
        }
        this.updateSelectionUI();
      });

      const cardInfo = card.querySelector('.card-info');
      cardInfo.addEventListener('click', () => {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });

      const btnPlay = card.querySelector('.btn-play-related');
      if (btnPlay) {
        btnPlay.addEventListener('click', (e) => {
          e.stopPropagation();
          this.downloadAndPlay(track, btnPlay);
        });
      }

      const btnDl = card.querySelector('.btn-action-download');
      if (btnDl) {
        btnDl.addEventListener('click', (e) => {
          e.stopPropagation();
          this.downloadTracks([track], { triggerBtn: btnDl });
        });
      }

      return card;
    },

    appendLoadMoreButton() {
      const existing = document.getElementById('related-load-more-wrap');
      if (existing) existing.remove();

      if (!this.continuationToken) return;

      const loadMoreContainer = document.createElement('div');
      loadMoreContainer.id = 'related-load-more-wrap';
      loadMoreContainer.className = 'py-3 px-2 flex justify-center shrink-0 border-t border-almond-cream/40 dark:border-[#222734]';
      loadMoreContainer.innerHTML = `
        <button type="button" id="btn-related-load-more" class="w-full sm:w-auto px-5 py-2 text-xs font-semibold rounded-xl bg-white dark:bg-[#1a1e27] border border-khaki-beige dark:border-[#353c4d] text-stone-brown dark:text-[#c6ac8f] hover:bg-almond-cream/40 dark:hover:bg-[#252b38] hover:text-black dark:hover:text-white transition shadow-xs inline-flex items-center justify-center gap-2 select-none cursor-pointer">
          <i data-lucide="plus-circle" class="w-4 h-4"></i>
          <span id="load-more-btn-text">Load More Recommendations</span>
        </button>
      `;
      this.elements.listContainer.appendChild(loadMoreContainer);

      const btnLoadMore = loadMoreContainer.querySelector('#btn-related-load-more');
      btnLoadMore.addEventListener('click', () => {
        this.loadMore();
      });
      if (window.lucide) window.lucide.createIcons();
    },

    async loadMore() {
      if (this.isLoadingMore || !this.continuationToken) return;
      this.isLoadingMore = true;

      const btn = document.getElementById('btn-related-load-more');
      const btnText = document.getElementById('load-more-btn-text');
      if (btn) {
        btn.disabled = true;
        btn.classList.add('opacity-75', 'pointer-events-none');
        if (btnText) btnText.innerHTML = '<span class="inline-flex items-center gap-2"><i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Loading more...</span>';
        if (window.lucide) window.lucide.createIcons();
      }

      const storage = CONFIG.storage || {};
      const workerUrl = (CONFIG.getWorkerEndpoint ? CONFIG.getWorkerEndpoint('/recommendations') : null) || localStorage.getItem(storage.workerRecsUrlKey) || '';
      const workerToken = localStorage.getItem(storage.workerTokenKey) || '';

      try {
        const cleanBase = workerUrl ? workerUrl.replace(/\/+$/, '') : '';
        const sep = cleanBase.includes('?') ? '&' : (cleanBase.endsWith('/recommendations') ? '?' : '/?');
        let targetUrl = `${cleanBase}${sep}continuation=${encodeURIComponent(this.continuationToken)}&excludeShorts=true`;
        if (this.currentVideoId) {
          targetUrl += `&videoId=${encodeURIComponent(this.currentVideoId)}`;
        }
        if (workerToken) {
          targetUrl += `&token=${encodeURIComponent(workerToken)}`;
        }

        const headers = { 'Accept': 'application/json' };
        if (workerToken) {
          headers['Authorization'] = `Bearer ${workerToken}`;
          headers['X-API-Key'] = workerToken;
        }

        const res = await fetch(targetUrl, { headers });
        if (!res.ok) {
          throw new Error(`Worker returned status ${res.status}`);
        }

        const data = await res.json();
        const newVideos = Array.isArray(data.videos) ? data.videos : [];
        this.continuationToken = data.continuation_token || null;

        if (newVideos.length > 0) {
          const existingIds = new Set(this.allVideos.map(v => v.id));
          const uniqueNewVideos = newVideos.filter(v => !existingIds.has(v.id));

          this.allVideos.push(...uniqueNewVideos);
          this.updateHeaderBadge();
          if (this.elements.footerStatus) {
            this.elements.footerStatus.innerText = `${this.allVideos.length} tracks ready`;
          }

          const loadMoreWrap = document.getElementById('related-load-more-wrap');
          if (loadMoreWrap) loadMoreWrap.remove();

          if (this.currentView === 'tracks') {
            uniqueNewVideos.forEach(v => {
              const card = this.createVideoCard(v);
              if (card) this.elements.listContainer.appendChild(card);
            });

            if (this.continuationToken) {
              this.appendLoadMoreButton();
            }
            if (window.lucide) window.lucide.createIcons();
          }
        } else {
          const loadMoreWrap = document.getElementById('related-load-more-wrap');
          if (loadMoreWrap) loadMoreWrap.remove();
        }
      } catch (err) {
        console.error('Failed to load more recommendations:', err);
        if (showToast) showToast('Could not load more recommendations.');
        if (btn) {
          btn.disabled = false;
          btn.classList.remove('opacity-75', 'pointer-events-none');
          if (btnText) btnText.innerText = 'Retry Loading More';
        }
      } finally {
        this.isLoadingMore = false;
      }
    },

    handleSelectAll(checked) {
      if (this.currentView === 'tracks') {
        if (checked) {
          this.allVideos.forEach(v => this.selectedVideos.set(v.id, v));
        } else {
          this.allVideos.forEach(v => this.selectedVideos.delete(v.id));
        }
      } else if (this.currentView === 'playlist-detail' && this.activePlaylist) {
        const tracks = this.playlistTracksCache.get(this.activePlaylist.id) || [];
        if (checked) {
          tracks.forEach(t => this.selectedVideos.set(t.id, t));
        } else {
          tracks.forEach(t => this.selectedVideos.delete(t.id));
        }
      }

      const checkboxes = this.elements.listContainer?.querySelectorAll('.related-item-checkbox') || [];
      checkboxes.forEach((cb) => {
        cb.checked = checked;
      });

      this.updateSelectionUI();
    },

    updateSelectionUI() {
      const count = this.selectedVideos.size;
      if (this.elements.selectedSummary) {
        this.elements.selectedSummary.innerText = `${count} selected`;
      }
      if (this.elements.btnDownloadSelected) {
        this.elements.btnDownloadSelected.disabled = count === 0;
        if (count > 0) {
          this.elements.btnDownloadSelected.classList.remove('opacity-50', 'cursor-not-allowed', 'disabled:pointer-events-none');
        } else {
          this.elements.btnDownloadSelected.classList.add('opacity-50', 'cursor-not-allowed', 'disabled:pointer-events-none');
        }
      }
      if (this.elements.btnDownloadSelectedLabel) {
        this.elements.btnDownloadSelectedLabel.innerText = count > 0 ? `Download Selected (${count})` : 'Download Selected';
      }

      if (this.elements.selectAll) {
        let currentList = [];
        if (this.currentView === 'tracks') {
          currentList = this.allVideos;
        } else if (this.currentView === 'playlist-detail' && this.activePlaylist) {
          currentList = this.playlistTracksCache.get(this.activePlaylist.id) || [];
        }

        if (currentList.length === 0) {
          this.elements.selectAll.checked = false;
          this.elements.selectAll.indeterminate = false;
        } else {
          const selectedInCurrent = currentList.filter(item => this.selectedVideos.has(item.id)).length;
          if (selectedInCurrent === currentList.length) {
            this.elements.selectAll.checked = true;
            this.elements.selectAll.indeterminate = false;
          } else if (selectedInCurrent > 0) {
            this.elements.selectAll.checked = false;
            this.elements.selectAll.indeterminate = true;
          } else {
            this.elements.selectAll.checked = false;
            this.elements.selectAll.indeterminate = false;
          }
        }
      }
    },

    downloadSelected() {
      if (this.selectedVideos.size === 0) return;
      const videos = Array.from(this.selectedVideos.values());
      this.downloadTracks(videos);
    },

    async downloadTracks(videos, { playWhenReadyVideoId = null, playWhenReadyTitle = '', triggerBtn = null } = {}) {
      if (!videos || videos.length === 0) return;

      const ghToken = localStorage.getItem(storage.ghTokenKey) || '';
      if (!ghToken) {
        if (showToast) showToast('GitHub PAT required for downloads');
        if (window.Trove.settings) {
          window.Trove.settings.open('GitHub Personal Access Token is required to dispatch downloads via GitHub Actions.');
        }
        return;
      }

      const defaultRepo = (CONFIG.github?.owner && CONFIG.github?.repo) ? `${CONFIG.github.owner}/${CONFIG.github.repo}` : 'mnswamedia/trove';
      const rawRepo = localStorage.getItem(storage.ghRepoKey) || defaultRepo;
      const repoParts = rawRepo.split('/').map(s => s.trim());
      if (repoParts.length !== 2) {
        alert('Invalid GitHub repository format (expected owner/repo).');
        return;
      }
      const [owner, repoName] = repoParts;
      const workflowFile = CONFIG.github?.workflowFile || 'ingest.yml';

      const targets = videos.map(v => v.url || (v.id ? `https://www.youtube.com/watch?v=${v.id}` : '')).filter(Boolean).join('\n');

      if (this.elements.footerStatus) {
        this.elements.footerStatus.innerText = `Dispatching ${videos.length} track(s)...`;
      }

      // Visual loading state on trigger button
      let origTriggerHtml = null;
      if (triggerBtn) {
        origTriggerHtml = triggerBtn.innerHTML;
        triggerBtn.disabled = true;
        triggerBtn.classList.add('pointer-events-none', 'opacity-75');
        triggerBtn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin text-current"></i>';
        if (window.lucide) window.lucide.createIcons();
      }

      const btnDlSelected = this.elements.btnDownloadSelected;
      const btnDlLabel = this.elements.btnDownloadSelectedLabel;
      let origDlLabelText = btnDlLabel ? btnDlLabel.innerText : '';
      if (btnDlSelected) {
        btnDlSelected.disabled = true;
        btnDlSelected.classList.add('opacity-75', 'pointer-events-none');
        if (btnDlLabel) {
          btnDlLabel.innerHTML = '<span class="inline-flex items-center gap-1.5"><i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Dispatching...</span>';
        }
        if (window.lucide) window.lucide.createIcons();
      }

      const resetBtns = () => {
        if (triggerBtn && origTriggerHtml !== null) {
          triggerBtn.disabled = false;
          triggerBtn.classList.remove('pointer-events-none', 'opacity-75');
          triggerBtn.innerHTML = origTriggerHtml;
          if (window.lucide) window.lucide.createIcons();
        }
        if (btnDlSelected) {
          btnDlSelected.disabled = false;
          btnDlSelected.classList.remove('opacity-75', 'pointer-events-none');
          if (btnDlLabel && origDlLabelText) {
            btnDlLabel.innerText = origDlLabelText;
          }
        }
      };

      const state = window.Trove.state || {};
      const bucketId = CONFIG.repo?.id || 'mnswa/trove_dataset';
      const workerUrl = CONFIG.getWorkerEndpoint ? CONFIG.getWorkerEndpoint('/ingest') : null;
      const workerToken = localStorage.getItem(storage.workerTokenKey) || '';

      try {
        let currentJobId = null;

        if (workerUrl) {
          const headers = { 'Content-Type': 'application/json' };
          if (workerToken) {
            headers['Authorization'] = `Bearer ${workerToken}`;
            headers['X-API-Key'] = workerToken;
          }

          const response = await fetch(`${workerUrl.replace(/\/+$/, '')}/dispatch`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              targets: targets,
              format: 'm4a',
              bucket_id: bucketId,
              hf_token: state.token || '',
              gh_token: ghToken,
              owner: owner,
              repo: repoName,
              ref: CONFIG.github?.ref || 'main',
              workflow: workflowFile
            })
          });

          if (!response.ok) {
            let errDetail = `Worker dispatch failed with status ${response.status}`;
            try {
              const errData = await response.json();
              errDetail = errData.error || errDetail;
            } catch (_) {}
            throw new Error(errDetail);
          }

          const resData = await response.json();
          currentJobId = resData.run_id || resData.job_id;
          if (currentJobId) {
            sessionStorage.setItem('trove_current_run_id', currentJobId);
            sessionStorage.setItem('trove_current_job_id', currentJobId);
          }
        } else {
          // Direct fallback to GitHub Actions dispatch API
          const dispatchUrl = `https://api.github.com/repos/${owner}/${repoName}/actions/workflows/${workflowFile}/dispatches`;
          const res = await fetch(dispatchUrl, {
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
                targets: targets,
                format: 'm4a',
                bucket_id: bucketId,
                hf_token: state.token || ''
              }
            })
          });

          if (!res.ok) {
            let errDetail = `GitHub API HTTP ${res.status}`;
            try {
              const errData = await res.json();
              errDetail = errData.message || errDetail;
            } catch (_) {}
            throw new Error(errDetail);
          }
        }

        if (playWhenReadyVideoId) {
          state.pendingAutoPlayId = playWhenReadyVideoId;
          state.pendingAutoPlayTitle = playWhenReadyTitle;
        }

        this.selectedVideos.clear();
        this.updateSelectionUI();
        this.close();

        const toastFn = showToast || window.Trove.utils?.showToast;
        if (toastFn) toastFn(`Dispatched ${videos.length} track(s) for ingestion!`);

      } catch (err) {
        console.error('Download dispatch error:', err);
        alert(`Failed to trigger download: ${err.message}`);
        if (this.elements.footerStatus) {
          this.elements.footerStatus.innerText = 'Download failed';
        }
      } finally {
        resetBtns();
      }
    },

    downloadAndPlay(video, triggerBtn = null) {
      if (!video) return;
      this.downloadTracks([video], {
        playWhenReadyVideoId: video.id,
        playWhenReadyTitle: video.title,
        triggerBtn
      });
    }
  };

  // Export
  window.Trove.recommendations = RelatedManager;
  window.RelatedManager = RelatedManager;
})();
