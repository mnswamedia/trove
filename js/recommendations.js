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
    cache: new Map(), // track.path -> { videoId, videos: [], sourceTitle }
    selectedVideos: new Map(), // videoId -> video object
    isLoading: false,
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
        this.renderVideos(cached.videos, cached.sourceTitle);
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
        this.renderVideos(cached.videos, cleanTitle);
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

        this.cache.set(track.path, { videoId, videos, sourceTitle: cleanTitle });
        this.setLoading(false);
        this.renderVideos(videos, cleanTitle);

      } catch (err) {
        console.error('Recommendations fetch error:', err);
        this.setLoading(false);
        this.renderEmpty(
          'Failed to load recommendations',
          err.message || 'Check your Cloudflare Worker URL, network connection, or API token.'
        );
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
        this.elements.btnRefresh.classList.toggle('animate-spin', loading);
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
      if (!this.elements.listContainer) return;
      this.elements.listContainer.innerHTML = '';

      if (!videos || videos.length === 0) {
        this.renderEmpty('No Recommendations', 'YouTube returned 0 recommendations for this track.');
        return;
      }

      if (this.elements.loadingState) this.elements.loadingState.classList.add('hidden');
      if (this.elements.emptyState) this.elements.emptyState.classList.add('hidden');
      this.elements.listContainer.classList.remove('hidden');

      if (this.elements.countBadge) {
        this.elements.countBadge.innerText = `${videos.length} found`;
      }
      if (this.elements.footerStatus) {
        this.elements.footerStatus.innerText = `${videos.length} tracks ready`;
      }

      videos.forEach((video) => {
        const card = document.createElement('div');
        card.className = 'p-2 sm:p-2.5 rounded-xl hover:bg-almond-cream/30 dark:hover:bg-[#1e232e] transition flex items-center gap-3 group select-none relative';

        const thumbUrl = video.thumbnail || (video.thumbnails && video.thumbnails[0]) || `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
        const titleEscaped = (video.title || 'Untitled Track').replace(/"/g, '&quot;');
        const channelEscaped = (video.channel || 'YouTube').replace(/"/g, '&quot;');

        card.innerHTML = `
          <!-- Checkbox -->
          <input type="checkbox" class="related-item-checkbox rounded border-khaki-beige dark:border-[#353c4d] text-jet-black dark:text-[#c6ac8f] shrink-0 cursor-pointer w-4 h-4" data-video-id="${video.id}">

          <!-- Thumbnail with duration badge -->
          <div class="relative w-16 h-12 sm:w-20 sm:h-14 rounded-lg overflow-hidden bg-almond-cream/40 dark:bg-[#12151c] shrink-0 shadow-sm border border-almond-cream/60 dark:border-[#262c38]">
            <img src="${thumbUrl}" alt="" class="w-full h-full object-cover" loading="lazy">
            ${video.duration ? `<span class="absolute bottom-0.5 right-0.5 px-1 py-0.2 rounded text-[9px] sm:text-[10px] font-mono font-bold bg-black/80 text-white leading-tight">${video.duration}</span>` : ''}
          </div>

          <!-- Title & Channel Info -->
          <div class="flex-1 min-w-0 pr-1">
            <div class="text-xs sm:text-sm font-semibold text-black dark:text-[#f3f4f6] truncate group-hover:text-accent-brown dark:group-hover:text-[#c6ac8f] transition" title="${titleEscaped}">
              ${video.title || 'Untitled'}
            </div>
            <div class="flex items-center gap-1.5 mt-0.5 text-[10px] sm:text-[11px] font-mono text-stone-brown/70 dark:text-[#9aa4b2]">
              <span class="truncate max-w-[120px] sm:max-w-[200px]">${channelEscaped}</span>
              ${video.view_count ? `<span>• ${video.view_count}</span>` : ''}
            </div>
          </div>

          <!-- Actions -->
          <div class="flex items-center gap-1 shrink-0">
            <!-- Play Next (Download & Auto-play) -->
            <button type="button" class="btn-play-related p-2 rounded-lg hover:bg-almond-cream/60 dark:hover:bg-[#282e3b] text-stone-brown dark:text-[#c6ac8f] hover:text-black dark:hover:text-white transition" title="Download & Play Next" data-video-id="${video.id}">
              <i data-lucide="play-circle" class="w-5 h-5"></i>
            </button>

            <!-- Item Menu Dropdown Wrapper -->
            <div class="relative item-menu-wrapper">
              <button type="button" class="btn-item-menu p-1.5 sm:p-2 rounded-lg hover:bg-almond-cream/60 dark:hover:bg-[#282e3b] text-stone-brown/60 dark:text-[#8b95a5] hover:text-black dark:hover:text-white transition" title="Options">
                <i data-lucide="more-vertical" class="w-4 h-4"></i>
              </button>
              <div class="item-menu-dropdown absolute right-0 bottom-full mb-1 w-44 bg-white dark:bg-[#1a1e27] border border-almond-cream dark:border-[#2f3747] rounded-xl shadow-xl py-1.5 z-30 hidden">
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
        btnPlay.addEventListener('click', () => {
          this.downloadAndPlay(video);
        });

        const btnMenu = card.querySelector('.btn-item-menu');
        const dropdown = card.querySelector('.item-menu-dropdown');
        btnMenu.addEventListener('click', (e) => {
          e.stopPropagation();
          const isHidden = dropdown.classList.contains('hidden');
          document.querySelectorAll('.item-menu-dropdown').forEach(d => d.classList.add('hidden'));
          if (isHidden) dropdown.classList.remove('hidden');
        });

        const btnDl = card.querySelector('.btn-action-download');
        btnDl.addEventListener('click', (e) => {
          e.stopPropagation();
          dropdown.classList.add('hidden');
          this.downloadTracks([video]);
        });

        const btnCopy = card.querySelector('.btn-action-copy');
        btnCopy.addEventListener('click', (e) => {
          e.stopPropagation();
          dropdown.classList.add('hidden');
          navigator.clipboard?.writeText(video.url);
          showToast('Copied YouTube URL to clipboard');
        });

        this.elements.listContainer.appendChild(card);
      });

      if (window.lucide) window.lucide.createIcons();
    },

    handleSelectAll(checked) {
      const currentList = this.cache.get(this.currentTrackPath)?.videos || [];
      const checkboxes = this.elements.listContainer?.querySelectorAll('.related-item-checkbox') || [];
      checkboxes.forEach((cb) => {
        cb.checked = checked;
      });

      if (checked) {
        currentList.forEach(v => this.selectedVideos.set(v.id, v));
      } else {
        this.selectedVideos.clear();
      }
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
        const total = this.cache.get(this.currentTrackPath)?.videos?.length || 0;
        this.elements.selectAll.checked = total > 0 && count === total;
      }
    },

    downloadSelected() {
      if (this.selectedVideos.size === 0) return;
      const videos = Array.from(this.selectedVideos.values());
      this.downloadTracks(videos);
    },

    async downloadTracks(videos, { playWhenReadyVideoId = null, playWhenReadyTitle = '' } = {}) {
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

      const targets = videos.map(v => v.url).join('\n');

      if (this.elements.footerStatus) {
        this.elements.footerStatus.innerText = `Dispatching ${videos.length} track(s)...`;
      }

      const state = window.Trove.state || {};

      try {
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
              bucket_id: repo.id,
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

        if (playWhenReadyVideoId) {
          state.pendingAutoPlayId = playWhenReadyVideoId;
          state.pendingAutoPlayTitle = playWhenReadyTitle;
        }

        this.selectedVideos.clear();
        this.updateSelectionUI();
        this.close();

        if (showToast) showToast(`Dispatched ${videos.length} track(s) to GitHub Actions!`);
        if (window.Trove.activity) {
          window.Trove.activity.startPolling();
          window.Trove.activity.open();
        }

      } catch (err) {
        console.error('Download dispatch error:', err);
        alert(`Failed to trigger download: ${err.message}`);
        if (this.elements.footerStatus) {
          this.elements.footerStatus.innerText = 'Download failed';
        }
      }
    },

    downloadAndPlay(video) {
      if (!video) return;
      this.downloadTracks([video], {
        playWhenReadyVideoId: video.id,
        playWhenReadyTitle: video.title
      });
    }
  };

  // Export
  window.Trove.recommendations = RelatedManager;
  window.RelatedManager = RelatedManager;
})();

