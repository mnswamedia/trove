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
  const { MotionAnim, showToast } = window.Trove.utils || {};

  const RelatedManager = {
    isOpen: false,
    currentTrackPath: null,
    currentVideoId: null,
    cache: new Map(), // track.path -> { videoId, videos: [], playlists: [], sourceTitle }
    selectedVideos: new Map(), // videoId -> video object
    allPlaylists: [],
    playlistTracksCache: new Map(), // playlistId -> tracks array
    expandedPlaylists: new Set(), // playlistId
    playlistTracksLoading: new Set(), // playlistId
    isLoading: false,
    continuationToken: null,
    allVideos: [],
    isLoadingMore: false,
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
        selectAll: document.getElementById('related-select-all'),
        selectedSummary: document.getElementById('related-selected-summary'),
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
      if (this.elements.btnDownloadSelected) {
        this.elements.btnDownloadSelected.addEventListener('click', () => {
          this.downloadSelected();
        });
      }

      document.addEventListener('click', (e) => {
        if (!e.target.closest('.item-menu-wrapper')) {
          document.querySelectorAll('.item-menu-dropdown').forEach(d => d.classList.add('hidden'));
          document.querySelectorAll('#related-list-container > div').forEach(c => c.classList.remove('z-30'));
        }
      });
    },

    open() {
      if (!this.elements.bottomSheet) return;
      this.isOpen = true;
      this.elements.bottomSheet.style.display = 'flex';
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
      if (!this.elements.listContainer) return;
      this.elements.listContainer.innerHTML = '';

      const totalItems = (videos ? videos.length : 0) + (playlists ? playlists.length : 0);
      if (totalItems === 0) {
        this.renderEmpty('No Recommendations', 'YouTube returned 0 recommendations for this track.');
        return;
      }

      if (this.elements.loadingState) this.elements.loadingState.classList.add('hidden');
      if (this.elements.emptyState) this.elements.emptyState.classList.add('hidden');
      this.elements.listContainer.classList.remove('hidden');

      if (this.elements.countBadge) {
        if (playlists && playlists.length > 0) {
          this.elements.countBadge.innerText = `${videos.length} tracks • ${playlists.length} playlists`;
        } else {
          this.elements.countBadge.innerText = `${videos.length} found`;
        }
      }
      if (this.elements.footerStatus) {
        this.elements.footerStatus.innerText = `${totalItems} recommendations ready`;
      }

      // Render playlists first with expandable sub-points
      if (playlists && playlists.length > 0) {
        playlists.forEach((playlist) => {
          const card = this.createPlaylistCard(playlist);
          this.elements.listContainer.appendChild(card);
        });
      }

      // Render video tracks
      if (videos && videos.length > 0) {
        videos.forEach((video) => {
          const card = this.createVideoCard(video);
          this.elements.listContainer.appendChild(card);
        });
      }

      if (this.continuationToken) {
        this.appendLoadMoreButton();
      }

      if (window.lucide) window.lucide.createIcons();
    },

    createPlaylistCard(playlist) {
      const wrapper = document.createElement('div');
      wrapper.className = 'playlist-card-wrapper py-1 select-none';
      wrapper.setAttribute('data-playlist-id', playlist.id);

      const thumbUrl = playlist.thumbnail || (playlist.thumbnails && playlist.thumbnails[0]) || '';
      const titleEscaped = (playlist.title || 'Untitled Playlist').replace(/"/g, '&quot;');
      const channelEscaped = (playlist.channel || 'YouTube').replace(/"/g, '&quot;');
      const videoCountText = playlist.video_count || '';
      const isExpanded = this.expandedPlaylists.has(playlist.id);

      wrapper.innerHTML = `
        <div class="playlist-header p-2 sm:p-2.5 rounded-xl hover:bg-almond-cream/30 dark:hover:bg-[#1e232e] transition flex items-center gap-2.5 sm:gap-3 group cursor-pointer relative">
          <!-- Playlist Checkbox -->
          <input type="checkbox" class="playlist-checkbox rounded border-khaki-beige dark:border-[#353c4d] text-jet-black dark:text-[#c6ac8f] shrink-0 cursor-pointer w-4 h-4" data-playlist-id="${playlist.id}">

          <!-- Stacked Playlist Thumbnail -->
          <div class="relative w-16 h-12 sm:w-20 sm:h-14 rounded-lg overflow-hidden bg-almond-cream/40 dark:bg-[#12151c] shrink-0 shadow-sm border border-almond-cream/60 dark:border-[#262c38]">
            ${thumbUrl ? `<img src="${thumbUrl}" alt="" class="w-full h-full object-cover" loading="lazy">` : `<div class="w-full h-full flex items-center justify-center bg-stone-brown/10 text-stone-brown/60"><i data-lucide="list-music" class="w-6 h-6"></i></div>`}
            <div class="absolute inset-y-0 right-0 w-6 bg-black/75 backdrop-blur-[1px] flex flex-col items-center justify-center text-white/90">
              <i data-lucide="list-music" class="w-3.5 h-3.5"></i>
            </div>
            ${videoCountText ? `<span class="absolute bottom-0.5 left-0.5 px-1 py-0.2 rounded text-[9px] font-mono font-bold bg-black/85 text-white leading-tight shadow-sm">${videoCountText}</span>` : ''}
          </div>

          <!-- Title, Channel & Playlist Badge -->
          <div class="flex-1 min-w-0 pr-1">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="px-1.5 py-0.5 text-[9px] font-bold rounded bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/30 uppercase tracking-wider shrink-0">Playlist</span>
              <div class="text-xs sm:text-sm font-semibold text-black dark:text-[#f3f4f6] truncate group-hover:text-accent-brown dark:group-hover:text-[#c6ac8f] transition" title="${titleEscaped}">
                ${playlist.title || 'Untitled Playlist'}
              </div>
            </div>
            <div class="flex items-center gap-1.5 mt-0.5 sm:mt-1 text-[10px] sm:text-[11px] font-mono text-stone-brown/70 dark:text-[#9aa4b2]">
              <span class="truncate max-w-[140px] sm:max-w-[220px]">${channelEscaped}</span>
              ${videoCountText ? `<span class="shrink-0">• ${videoCountText}</span>` : ''}
            </div>
          </div>

          <!-- Actions: Expand Chevron + Options Menu -->
          <div class="flex items-center gap-1 shrink-0">
            <!-- Expand / Collapse Button -->
            <button type="button" class="btn-toggle-playlist p-1.5 sm:p-2 rounded-lg hover:bg-almond-cream/60 dark:hover:bg-[#282e3b] text-stone-brown dark:text-[#c6ac8f] transition cursor-pointer" title="${isExpanded ? 'Collapse tracks' : 'Expand tracks'}">
              <i data-lucide="chevron-down" class="w-4 h-4 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}"></i>
            </button>

            <!-- Item Menu Dropdown Wrapper -->
            <div class="relative item-menu-wrapper">
              <button type="button" class="btn-item-menu p-1.5 sm:p-2 rounded-lg hover:bg-almond-cream/60 dark:hover:bg-[#282e3b] text-stone-brown/60 dark:text-[#8b95a5] hover:text-black dark:hover:text-white transition cursor-pointer" title="Options">
                <i data-lucide="more-vertical" class="w-4 h-4"></i>
              </button>
              <div class="item-menu-dropdown absolute right-0 w-48 bg-white dark:bg-[#1a1e27] border border-almond-cream dark:border-[#2f3747] rounded-xl shadow-2xl py-1.5 z-40 hidden">
                <button type="button" class="btn-playlist-download-all w-full px-3 py-1.5 text-left text-xs text-jet-black dark:text-[#f3f4f6] hover:bg-almond-cream/40 dark:hover:bg-[#282e3b] flex items-center gap-2">
                  <i data-lucide="download" class="w-3.5 h-3.5"></i>
                  <span>Download All Tracks</span>
                </button>
                <button type="button" class="btn-action-copy w-full px-3 py-1.5 text-left text-xs text-jet-black dark:text-[#f3f4f6] hover:bg-almond-cream/40 dark:hover:bg-[#282e3b] flex items-center gap-2">
                  <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                  <span>Copy Playlist URL</span>
                </button>
                <a href="${playlist.url}" target="_blank" rel="noopener noreferrer" class="w-full px-3 py-1.5 text-left text-xs text-jet-black dark:text-[#f3f4f6] hover:bg-almond-cream/40 dark:hover:bg-[#282e3b] flex items-center gap-2">
                  <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                  <span>Open on YouTube</span>
                </a>
              </div>
            </div>
          </div>
        </div>

        <!-- Subtracks Tree Container (Indented with vertical connecting guide) -->
        <div class="playlist-subtracks-container ${isExpanded ? '' : 'hidden'} mt-1 ml-5 sm:ml-7 pl-3 sm:pl-4 border-l-2 border-almond-cream/80 dark:border-[#2b3342] space-y-1">
          <!-- Dynamic child tracks will be rendered here -->
        </div>
      `;

      const headerRow = wrapper.querySelector('.playlist-header');
      const toggleBtn = wrapper.querySelector('.btn-toggle-playlist');
      const chevron = toggleBtn.querySelector('i, svg');
      const subtracksContainer = wrapper.querySelector('.playlist-subtracks-container');
      const playlistCb = wrapper.querySelector('.playlist-checkbox');

      const toggleExpand = async () => {
        const currentlyHidden = subtracksContainer.classList.contains('hidden');
        if (currentlyHidden) {
          subtracksContainer.classList.remove('hidden');
          this.expandedPlaylists.add(playlist.id);
          if (chevron) chevron.classList.add('rotate-180');
          toggleBtn.title = 'Collapse tracks';
          await this.loadPlaylistTracksIntoContainer(playlist, subtracksContainer, playlistCb);
        } else {
          subtracksContainer.classList.add('hidden');
          this.expandedPlaylists.delete(playlist.id);
          if (chevron) chevron.classList.remove('rotate-180');
          toggleBtn.title = 'Expand tracks';
        }
      };

      headerRow.addEventListener('click', (e) => {
        if (e.target.closest('.playlist-checkbox') || e.target.closest('.item-menu-wrapper') || e.target.closest('.btn-toggle-playlist')) {
          return;
        }
        toggleExpand();
      });

      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleExpand();
      });

      // Checkbox listener on parent playlist
      playlistCb.addEventListener('change', async (e) => {
        const isChecked = e.target.checked;
        playlistCb.indeterminate = false;

        // If subtracks not yet loaded, expand and load them
        if (subtracksContainer.dataset.loaded !== 'true') {
          subtracksContainer.classList.remove('hidden');
          this.expandedPlaylists.add(playlist.id);
          if (chevron) chevron.classList.add('rotate-180');
          toggleBtn.title = 'Collapse tracks';
          await this.loadPlaylistTracksIntoContainer(playlist, subtracksContainer, playlistCb);
        }

        const childCbs = subtracksContainer.querySelectorAll('.playlist-track-checkbox');
        const tracks = this.playlistTracksCache.get(playlist.id) || [];
        childCbs.forEach((cb) => {
          cb.checked = isChecked;
        });

        if (isChecked) {
          tracks.forEach(t => this.selectedVideos.set(t.id, t));
        } else {
          tracks.forEach(t => this.selectedVideos.delete(t.id));
        }
        this.updateSelectionUI();
      });

      // Options menu in parent playlist
      const btnMenu = wrapper.querySelector('.btn-item-menu');
      const dropdown = wrapper.querySelector('.item-menu-dropdown');
      btnMenu.addEventListener('click', (e) => {
        e.stopPropagation();
        const isHidden = dropdown.classList.contains('hidden');
        document.querySelectorAll('.item-menu-dropdown').forEach(d => d.classList.add('hidden'));
        document.querySelectorAll('#related-list-container > div').forEach(c => c.classList.remove('z-30'));

        if (isHidden) {
          const btnRect = btnMenu.getBoundingClientRect();
          const containerRect = this.elements.listContainer.getBoundingClientRect();
          const spaceBelow = containerRect.bottom - btnRect.bottom;

          dropdown.classList.remove('top-full', 'mt-1', 'bottom-full', 'mb-1');
          if (spaceBelow < 160) {
            dropdown.classList.add('bottom-full', 'mb-1');
          } else {
            dropdown.classList.add('top-full', 'mt-1');
          }

          wrapper.classList.add('z-30');
          dropdown.classList.remove('hidden');
        }
      });

      const btnDlAll = wrapper.querySelector('.btn-playlist-download-all');
      btnDlAll.addEventListener('click', async (e) => {
        e.stopPropagation();
        dropdown.classList.add('hidden');
        wrapper.classList.remove('z-30');
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

      const btnCopy = wrapper.querySelector('.btn-action-copy');
      btnCopy.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.add('hidden');
        wrapper.classList.remove('z-30');
        navigator.clipboard?.writeText(playlist.url);
        if (showToast) showToast('Copied playlist URL to clipboard');
      });

      // If already expanded in a previous session, restore its tracks
      if (isExpanded) {
        this.loadPlaylistTracksIntoContainer(playlist, subtracksContainer, playlistCb);
      }

      return wrapper;
    },

    async loadPlaylistTracksIntoContainer(playlist, container, playlistCb) {
      if (container.dataset.loaded === 'true') {
        return;
      }

      container.innerHTML = `
        <div class="py-2.5 px-3 flex items-center gap-2 text-xs font-mono text-stone-brown/70 dark:text-[#8b95a5]">
          <i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin text-stone-brown dark:text-[#c6ac8f]"></i>
          <span>Loading tracks...</span>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();

      const tracks = await this.fetchPlaylistTracks(playlist.id);
      container.innerHTML = '';
      container.dataset.loaded = 'true';

      if (!tracks || tracks.length === 0) {
        container.innerHTML = `
          <div class="py-2 px-3 text-xs font-mono text-stone-brown/60 dark:text-[#758092]">
            No playable tracks found in this playlist.
          </div>
        `;
        return;
      }

      const shouldCheckAll = playlistCb && playlistCb.checked;

      tracks.forEach((track, index) => {
        const trackCard = this.createPlaylistTrackCard(track, playlist, index + 1);
        container.appendChild(trackCard);

        const cb = trackCard.querySelector('.playlist-track-checkbox');
        if (shouldCheckAll && cb) {
          cb.checked = true;
          this.selectedVideos.set(track.id, track);
        } else if (this.selectedVideos.has(track.id) && cb) {
          cb.checked = true;
        }
      });

      this.updatePlaylistCheckboxState(playlist.id, playlistCb, container);
      this.updateSelectionUI();

      if (window.lucide) window.lucide.createIcons();
    },

    createPlaylistTrackCard(track, playlist, trackNumber) {
      const card = document.createElement('div');
      card.className = 'p-1.5 sm:p-2 rounded-lg hover:bg-almond-cream/40 dark:hover:bg-[#1a1e27] transition flex items-center gap-2 sm:gap-2.5 group select-none relative';

      const thumbUrl = track.thumbnail || (track.thumbnails && track.thumbnails[0]) || `https://i.ytimg.com/vi/${track.id}/hqdefault.jpg`;
      const titleEscaped = (track.title || 'Untitled Track').replace(/"/g, '&quot;');
      const channelEscaped = (track.channel || playlist.channel || 'YouTube').replace(/"/g, '&quot;');
      const durationText = track.duration || '';

      card.innerHTML = `
        <!-- Sub-track Checkbox -->
        <input type="checkbox" class="related-item-checkbox playlist-track-checkbox rounded border-khaki-beige dark:border-[#353c4d] text-jet-black dark:text-[#c6ac8f] shrink-0 cursor-pointer w-3.5 h-3.5" data-playlist-id="${playlist.id}" data-video-id="${track.id}">

        <!-- Index Number -->
        <span class="w-4 text-center font-mono text-[10px] text-stone-brown/50 dark:text-[#758092] shrink-0">${trackNumber}</span>

        <!-- Compact Thumbnail with duration -->
        <div class="relative w-12 h-9 sm:w-14 sm:h-10 rounded-md overflow-hidden bg-almond-cream/40 dark:bg-[#12151c] shrink-0 shadow-xs border border-almond-cream/60 dark:border-[#262c38]">
          <img src="${thumbUrl}" alt="" class="w-full h-full object-cover" loading="lazy">
          ${durationText ? `<span class="absolute bottom-0.5 right-0.5 px-0.5 py-0.2 rounded text-[8px] font-mono font-bold bg-black/85 text-white leading-none">${durationText}</span>` : ''}
        </div>

        <!-- Title & Channel -->
        <div class="flex-1 min-w-0 pr-1">
          <div class="text-xs font-medium text-black dark:text-[#f3f4f6] truncate group-hover:text-accent-brown dark:group-hover:text-[#c6ac8f] transition" title="${titleEscaped}">
            ${track.title || 'Untitled'}
          </div>
          <div class="flex items-center gap-1 text-[10px] font-mono text-stone-brown/70 dark:text-[#9aa4b2]">
            <span class="truncate max-w-[120px] sm:max-w-[180px]">${channelEscaped}</span>
          </div>
        </div>

        <!-- Actions -->
        <div class="flex items-center gap-0.5 shrink-0">
          <!-- Play Next -->
          <button type="button" class="btn-play-related p-1.5 rounded-md hover:bg-almond-cream/60 dark:hover:bg-[#282e3b] text-stone-brown dark:text-[#c6ac8f] hover:text-black dark:hover:text-white transition cursor-pointer" title="Download & Play Next" data-video-id="${track.id}">
            <i data-lucide="play-circle" class="w-4 h-4"></i>
          </button>

          <!-- Item Menu Dropdown Wrapper -->
          <div class="relative item-menu-wrapper">
            <button type="button" class="btn-item-menu p-1.5 rounded-md hover:bg-almond-cream/60 dark:hover:bg-[#282e3b] text-stone-brown/60 dark:text-[#8b95a5] hover:text-black dark:hover:text-white transition cursor-pointer" title="Options">
              <i data-lucide="more-vertical" class="w-3.5 h-3.5"></i>
            </button>
            <div class="item-menu-dropdown absolute right-0 w-44 bg-white dark:bg-[#1a1e27] border border-almond-cream dark:border-[#2f3747] rounded-xl shadow-2xl py-1 z-40 hidden">
              <button type="button" class="btn-action-download w-full px-3 py-1.5 text-left text-xs text-jet-black dark:text-[#f3f4f6] hover:bg-almond-cream/40 dark:hover:bg-[#282e3b] flex items-center gap-2">
                <i data-lucide="download" class="w-3.5 h-3.5"></i>
                <span>Download to Vault</span>
              </button>
              <button type="button" class="btn-action-copy w-full px-3 py-1.5 text-left text-xs text-jet-black dark:text-[#f3f4f6] hover:bg-almond-cream/40 dark:hover:bg-[#282e3b] flex items-center gap-2">
                <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                <span>Copy URL</span>
              </button>
              <a href="${track.url}" target="_blank" rel="noopener noreferrer" class="w-full px-3 py-1.5 text-left text-xs text-jet-black dark:text-[#f3f4f6] hover:bg-almond-cream/40 dark:hover:bg-[#282e3b] flex items-center gap-2">
                <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                <span>Open on YouTube</span>
              </a>
            </div>
          </div>
        </div>
      `;

      const cb = card.querySelector('.playlist-track-checkbox');
      cb.addEventListener('change', (e) => {
        if (e.target.checked) {
          this.selectedVideos.set(track.id, track);
        } else {
          this.selectedVideos.delete(track.id);
        }
        const wrapper = card.closest('.playlist-card-wrapper');
        const playlistCb = wrapper ? wrapper.querySelector('.playlist-checkbox') : null;
        const subtracksContainer = wrapper ? wrapper.querySelector('.playlist-subtracks-container') : null;
        this.updatePlaylistCheckboxState(playlist.id, playlistCb, subtracksContainer);
        this.updateSelectionUI();
      });

      const btnPlay = card.querySelector('.btn-play-related');
      if (btnPlay) {
        btnPlay.addEventListener('click', () => {
          this.downloadAndPlay(track, btnPlay);
        });
      }

      const btnMenu = card.querySelector('.btn-item-menu');
      const dropdown = card.querySelector('.item-menu-dropdown');
      btnMenu.addEventListener('click', (e) => {
        e.stopPropagation();
        const isHidden = dropdown.classList.contains('hidden');
        document.querySelectorAll('.item-menu-dropdown').forEach(d => d.classList.add('hidden'));
        document.querySelectorAll('#related-list-container > div').forEach(c => c.classList.remove('z-30'));

        if (isHidden) {
          const btnRect = btnMenu.getBoundingClientRect();
          const containerRect = this.elements.listContainer.getBoundingClientRect();
          const spaceBelow = containerRect.bottom - btnRect.bottom;

          dropdown.classList.remove('top-full', 'mt-1', 'bottom-full', 'mb-1');
          if (spaceBelow < 150) {
            dropdown.classList.add('bottom-full', 'mb-1');
          } else {
            dropdown.classList.add('top-full', 'mt-1');
          }

          card.classList.add('z-30');
          dropdown.classList.remove('hidden');
        }
      });

      const btnDl = card.querySelector('.btn-action-download');
      btnDl.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.add('hidden');
        card.classList.remove('z-30');
        this.downloadTracks([track], { triggerBtn: btnDl });
      });

      const btnCopy = card.querySelector('.btn-action-copy');
      btnCopy.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.add('hidden');
        card.classList.remove('z-30');
        navigator.clipboard?.writeText(track.url);
        if (showToast) showToast('Copied YouTube URL to clipboard');
      });

      return card;
    },

    updatePlaylistCheckboxState(playlistId, playlistCb, subtracksContainer) {
      if (!playlistCb) return;
      const childCbs = subtracksContainer ? Array.from(subtracksContainer.querySelectorAll('.playlist-track-checkbox')) : [];
      if (childCbs.length === 0) return;

      const checkedCount = childCbs.filter(cb => cb.checked).length;
      if (checkedCount === childCbs.length) {
        playlistCb.checked = true;
        playlistCb.indeterminate = false;
      } else if (checkedCount > 0) {
        playlistCb.checked = false;
        playlistCb.indeterminate = true;
      } else {
        playlistCb.checked = false;
        playlistCb.indeterminate = false;
      }
    },

    createVideoCard(video) {
      const card = document.createElement('div');
      card.className = 'p-2 sm:p-2.5 rounded-xl hover:bg-almond-cream/30 dark:hover:bg-[#1e232e] transition flex items-center gap-2.5 sm:gap-3 group select-none relative';

      const thumbUrl = video.thumbnail || (video.thumbnails && video.thumbnails[0]) || `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
      const titleEscaped = (video.title || 'Untitled Track').replace(/"/g, '&quot;');
      const channelEscaped = (video.channel || 'YouTube').replace(/"/g, '&quot;');
      const durationText = video.duration || '';
      const tags = Array.isArray(video.tags) ? video.tags : [];

      card.innerHTML = `
        <!-- Checkbox -->
        <input type="checkbox" class="related-item-checkbox rounded border-khaki-beige dark:border-[#353c4d] text-jet-black dark:text-[#c6ac8f] shrink-0 cursor-pointer w-4 h-4" data-video-id="${video.id}">

        <!-- Thumbnail with duration badge -->
        <div class="relative w-16 h-12 sm:w-20 sm:h-14 rounded-lg overflow-hidden bg-almond-cream/40 dark:bg-[#12151c] shrink-0 shadow-sm border border-almond-cream/60 dark:border-[#262c38]">
          <img src="${thumbUrl}" alt="" class="w-full h-full object-cover" loading="lazy">
          ${durationText ? `<span class="absolute bottom-0.5 right-0.5 px-1 py-0.5 rounded text-[9px] sm:text-[10px] font-mono font-bold bg-black/85 text-white leading-none shadow-sm">${durationText}</span>` : ''}
        </div>

        <!-- Title, Tags & Channel Info -->
        <div class="flex-1 min-w-0 pr-1">
          <div class="text-xs sm:text-sm font-semibold text-black dark:text-[#f3f4f6] truncate group-hover:text-accent-brown dark:group-hover:text-[#c6ac8f] transition" title="${titleEscaped}">
            ${video.title || 'Untitled'}
          </div>
          ${tags.length > 0 ? `
            <div class="flex items-center gap-1 mt-0.5 flex-wrap">
              ${tags.slice(0, 3).map(tag => `
                <span class="px-1.5 py-0.5 text-[9px] font-medium rounded-md bg-almond-cream/50 dark:bg-[#1f2430] text-stone-brown/80 dark:text-[#c6ac8f] border border-almond-cream/70 dark:border-[#2b3342] leading-none">
                  ${(tag || '').replace(/"/g, '&quot;')}
                </span>
              `).join('')}
            </div>
          ` : ''}
          <div class="flex items-center gap-1.5 mt-0.5 sm:mt-1 text-[10px] sm:text-[11px] font-mono text-stone-brown/70 dark:text-[#9aa4b2]">
            <span class="truncate max-w-[120px] sm:max-w-[200px]">${channelEscaped}</span>
            ${video.view_count || video.views ? `<span class="shrink-0">• ${video.view_count || video.views}</span>` : ''}
          </div>
        </div>

        <!-- Actions -->
        <div class="flex items-center gap-1 shrink-0">
          <!-- Play Next: hidden on mobile to avoid cramming, visible on desktop -->
          <button type="button" class="btn-play-related hidden sm:inline-flex p-2 rounded-lg hover:bg-almond-cream/60 dark:hover:bg-[#282e3b] text-stone-brown dark:text-[#c6ac8f] hover:text-black dark:hover:text-white transition" title="Download & Play Next" data-video-id="${video.id}">
            <i data-lucide="play-circle" class="w-5 h-5"></i>
          </button>

          <!-- Item Menu Dropdown Wrapper -->
          <div class="relative item-menu-wrapper">
            <button type="button" class="btn-item-menu p-1.5 sm:p-2 rounded-lg hover:bg-almond-cream/60 dark:hover:bg-[#282e3b] text-stone-brown/60 dark:text-[#8b95a5] hover:text-black dark:hover:text-white transition" title="Options">
              <i data-lucide="more-vertical" class="w-4 h-4"></i>
            </button>
            <div class="item-menu-dropdown absolute right-0 w-48 bg-white dark:bg-[#1a1e27] border border-almond-cream dark:border-[#2f3747] rounded-xl shadow-2xl py-1.5 z-40 hidden">
              <!-- Mobile only: Download & Play Next -->
              <button type="button" class="btn-action-play-next w-full px-3 py-2 text-left text-xs text-jet-black dark:text-[#f3f4f6] hover:bg-almond-cream/40 dark:hover:bg-[#282e3b] flex items-center gap-2 sm:hidden font-medium">
                <i data-lucide="play-circle" class="w-4 h-4 text-accent-brown dark:text-[#c6ac8f]"></i>
                <span>Download & Play Next</span>
              </button>
              <button type="button" class="btn-action-download w-full px-3 py-1.5 text-left text-xs text-jet-black dark:text-[#f3f4f6] hover:bg-almond-cream/40 dark:hover:bg-[#282e3b] flex items-center gap-2">
                <i data-lucide="download" class="w-3.5 h-3.5"></i>
                <span>Download to Vault</span>
              </button>
              <button type="button" class="btn-action-copy w-full px-3 py-1.5 text-left text-xs text-jet-black dark:text-[#f3f4f6] hover:bg-almond-cream/40 dark:hover:bg-[#282e3b] flex items-center gap-2">
                <i data-lucide="copy" class="w-3.5 h-3.5"></i>
                <span>Copy URL</span>
              </button>
              <a href="${video.url}" target="_blank" rel="noopener noreferrer" class="w-full px-3 py-1.5 text-left text-xs text-jet-black dark:text-[#f3f4f6] hover:bg-almond-cream/40 dark:hover:bg-[#282e3b] flex items-center gap-2">
                <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                <span>Open on YouTube</span>
              </a>
            </div>
          </div>
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

      const btnPlay = card.querySelector('.btn-play-related');
      if (btnPlay) {
        btnPlay.addEventListener('click', () => {
          this.downloadAndPlay(video, btnPlay);
        });
      }

      const btnMenu = card.querySelector('.btn-item-menu');
      const dropdown = card.querySelector('.item-menu-dropdown');
      btnMenu.addEventListener('click', (e) => {
        e.stopPropagation();
        const isHidden = dropdown.classList.contains('hidden');
        document.querySelectorAll('.item-menu-dropdown').forEach(d => d.classList.add('hidden'));
        document.querySelectorAll('#related-list-container > div').forEach(c => c.classList.remove('z-30'));

        if (isHidden) {
          const btnRect = btnMenu.getBoundingClientRect();
          const containerRect = this.elements.listContainer.getBoundingClientRect();
          const spaceBelow = containerRect.bottom - btnRect.bottom;

          dropdown.classList.remove('top-full', 'mt-1', 'bottom-full', 'mb-1');
          if (spaceBelow < 180) {
            dropdown.classList.add('bottom-full', 'mb-1');
          } else {
            dropdown.classList.add('top-full', 'mt-1');
          }

          card.classList.add('z-30');
          dropdown.classList.remove('hidden');
        }
      });

      const btnPlayNext = card.querySelector('.btn-action-play-next');
      if (btnPlayNext) {
        btnPlayNext.addEventListener('click', (e) => {
          e.stopPropagation();
          dropdown.classList.add('hidden');
          card.classList.remove('z-30');
          this.downloadAndPlay(video, btnPlayNext);
        });
      }

      const btnDl = card.querySelector('.btn-action-download');
      btnDl.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.add('hidden');
        card.classList.remove('z-30');
        this.downloadTracks([video], { triggerBtn: btnDl });
      });

      const btnCopy = card.querySelector('.btn-action-copy');
      btnCopy.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.add('hidden');
        card.classList.remove('z-30');
        navigator.clipboard?.writeText(video.url);
        showToast('Copied YouTube URL to clipboard');
      });

      return card;
    },

    appendLoadMoreButton() {
      const existing = document.getElementById('related-load-more-wrap');
      if (existing) existing.remove();

      if (!this.continuationToken) return;

      const loadMoreContainer = document.createElement('div');
      loadMoreContainer.id = 'related-load-more-wrap';
      loadMoreContainer.className = 'py-3.5 px-2 flex justify-center shrink-0 border-t border-almond-cream/40 dark:border-[#222734]';
      loadMoreContainer.innerHTML = `
        <button type="button" id="btn-related-load-more" class="w-full sm:w-auto px-5 py-2.5 text-xs font-semibold rounded-xl bg-white dark:bg-[#1a1e27] border border-khaki-beige dark:border-[#353c4d] text-stone-brown dark:text-[#c6ac8f] hover:bg-almond-cream/40 dark:hover:bg-[#252b38] hover:text-black dark:hover:text-white transition shadow-sm inline-flex items-center justify-center gap-2 select-none">
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
      const workerUrl = CONFIG.getWorkerEndpoint ? CONFIG.getWorkerEndpoint('recommendations') : null;
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
          if (this.elements.countBadge) {
            this.elements.countBadge.innerText = `${this.allVideos.length} found`;
          }
          if (this.elements.footerStatus) {
            this.elements.footerStatus.innerText = `${this.allVideos.length} tracks ready`;
          }

          const loadMoreWrap = document.getElementById('related-load-more-wrap');
          if (loadMoreWrap) loadMoreWrap.remove();

          uniqueNewVideos.forEach(v => {
            const card = this.createVideoCard(v);
            this.elements.listContainer.appendChild(card);
          });

          if (this.continuationToken) {
            this.appendLoadMoreButton();
          }
          if (window.lucide) window.lucide.createIcons();
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
      const currentList = this.allVideos.length > 0 ? this.allVideos : (this.cache.get(this.currentTrackPath)?.videos || []);
      if (checked) {
        currentList.forEach(v => this.selectedVideos.set(v.id, v));
      } else {
        this.selectedVideos.clear();
      }

      // Also select / unselect all loaded playlist tracks
      this.playlistTracksCache.forEach((tracks) => {
        if (Array.isArray(tracks)) {
          tracks.forEach(t => {
            if (checked) {
              this.selectedVideos.set(t.id, t);
            } else {
              this.selectedVideos.delete(t.id);
            }
          });
        }
      });

      const checkboxes = this.elements.listContainer?.querySelectorAll('.related-item-checkbox') || [];
      checkboxes.forEach((cb) => {
        cb.checked = checked;
      });

      const playlistCbs = this.elements.listContainer?.querySelectorAll('.playlist-checkbox') || [];
      playlistCbs.forEach((pcb) => {
        pcb.checked = checked;
        pcb.indeterminate = false;
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
        let totalCount = this.allVideos.length;
        this.playlistTracksCache.forEach((tracks) => {
          if (Array.isArray(tracks)) totalCount += tracks.length;
        });
        this.elements.selectAll.checked = totalCount > 0 && count === totalCount;
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

      // Visual loading state on button(s)
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

