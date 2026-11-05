/**
 * Trove Media Vault - Explorer & File Browser
 * Directory tree building, path traversal, search indexing, filter pills, and file table rendering.
 */
(function() {
  window.Trove = window.Trove || {};

  const CONFIG = window.APP_CONFIG || {};
  const repo = CONFIG.repo || {};
  const api = CONFIG.api || {};
  const { getFileInfo, formatBytes, formatRelativeTime, escapeHtml, MotionAnim, getIDB } = window.Trove.utils || {};

  const FILTER_CONFIG = {
    all: { label: 'All', fullLabel: 'All Files', icon: 'layers' },
    music: { label: 'Music', fullLabel: 'Music', icon: 'music' },
    video: { label: 'Video', fullLabel: 'Video', icon: 'video' },
    document: { label: 'Docs', fullLabel: 'Text / Docs', icon: 'file-text' },
    image: { label: 'Images', fullLabel: 'Images', icon: 'image' },
    other: { label: 'Other', fullLabel: 'Other Files', icon: 'file' }
  };

  // High-performance direct SVG icons for track rows (eliminates Lucide scan bottleneck)
  const ROW_ICONS = {
    heart: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>',
    heartFilled: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>',
    'list-plus': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M11 12H3"/><path d="M16 6H3"/><path d="M16 18H3"/><path d="M18 9v6"/><path d="M21 12h-6"/></svg>',
    'folder-plus': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/></svg>',
    'volume-2': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
    music: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    video: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>',
    folder: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>',
    'file-text': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
    image: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
    file: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>',
    'corner-left-up': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><polyline points="14 9 9 4 4 9"/><path d="M20 20h-7a4 4 0 0 1-4-4V4"/></svg>'
  };

  function getRowSvg(name) {
    return ROW_ICONS[name] || ROW_ICONS.file;
  }

  const ExplorerManager = {
    elements: {},
    thumbnailObserver: null,
    extractionQueue: [],
    isExtractingQueue: false,
    filterDownloaded: false,
    downloadedPaths: [],
    currentDisplayItems: [],
    virtualStartIndex: -1,
    virtualEndIndex: -1,
    scrollRafId: null,
    rowHeight: 58,
    bufferSize: 12,

    init() {
      this.elements = {
        fileList: document.getElementById('file-list'),
        virtualParentDir: document.getElementById('virtual-parent-dir'),
        topSpacer: document.getElementById('virtual-spacer-top'),
        itemsContainer: document.getElementById('virtual-items-container'),
        bottomSpacer: document.getElementById('virtual-spacer-bottom'),
        breadcrumbs: document.getElementById('breadcrumbs'),
        refreshBtn: document.getElementById('refresh-btn'),
        mobileRefreshBtn: document.getElementById('mobile-refresh-btn'),
        searchInput: document.getElementById('search-input'),
        clearSearchBtn: document.getElementById('clear-search-btn'),
        viewToggleBtn: document.getElementById('view-toggle-btn'),
        btnFilterDownloaded: document.getElementById('btn-filter-downloaded'),
        filterDropdownBtn: document.getElementById('filter-dropdown-btn'),
        filterDropdownMenu: document.getElementById('filter-dropdown-menu'),
        filterActiveLabel: document.getElementById('filter-active-label'),
        filterActiveIcon: document.getElementById('filter-active-icon'),
        sortDropdownBtn: document.getElementById('sort-dropdown-btn'),
        sortDropdownMenu: document.getElementById('sort-dropdown-menu'),
        sortActiveLabel: document.getElementById('sort-active-label'),
        colSortName: document.getElementById('col-sort-name'),
        colSortSize: document.getElementById('col-sort-size'),
        colSortDate: document.getElementById('col-sort-date'),
        statTotalFiles: document.getElementById('stat-total-files'),
        statMusicCount: document.getElementById('stat-music-count'),
        statVideoCount: document.getElementById('stat-video-count'),
        statTotalSize: document.getElementById('stat-total-size'),
        explorerState: document.getElementById('explorer-state'),
        stateIcon: document.getElementById('state-icon'),
        stateTitle: document.getElementById('state-title'),
        stateDesc: document.getElementById('state-desc'),
        stateActionBtn: document.getElementById('state-action-btn'),
        footerStatus: document.getElementById('footer-status')
      };

      if (window.Trove.store) {
        window.Trove.store.loadSavedViewSettings();
      }

      this.updateViewToggleUI();
      this.updateFilterDropdownUI();
      this.updateSortUI();
      this.setupEventListeners();
      this.loadStoredThumbnails();
    },

    updateSortUI() {
      const state = window.Trove.state || {};
      const sortBy = state.sortBy || 'name';
      const sortOrder = state.sortOrder || 'asc';

      // Update Toolbar Sort Button Label
      if (this.elements.sortActiveLabel) {
        let label = 'Name (A-Z)';
        if (sortBy === 'date') {
          label = sortOrder === 'desc' ? 'Recent' : 'Oldest';
        } else if (sortBy === 'name') {
          label = sortOrder === 'desc' ? 'Name (Z-A)' : 'Name (A-Z)';
        } else if (sortBy === 'size') {
          label = sortOrder === 'desc' ? 'Size (Large)' : 'Size (Small)';
        }
        this.elements.sortActiveLabel.innerText = label;
      }

      // Update checkmark in Sort Dropdown Menu
      if (this.elements.sortDropdownMenu) {
        const options = this.elements.sortDropdownMenu.querySelectorAll('.sort-option');
        options.forEach(opt => {
          const optSort = opt.dataset.sort;
          const optOrder = opt.dataset.order;
          const checkIcon = opt.querySelector('.sort-check-icon');
          if (checkIcon) {
            if (optSort === sortBy && optOrder === sortOrder) {
              checkIcon.classList.remove('hidden');
            } else {
              checkIcon.classList.add('hidden');
            }
          }
        });
      }

      // Update Table Column Headers indicators
      const colHeaders = [
        { el: this.elements.colSortName, key: 'name' },
        { el: this.elements.colSortSize, key: 'size' },
        { el: this.elements.colSortDate, key: 'date' }
      ];

      colHeaders.forEach(({ el, key }) => {
        if (!el) return;
        const indicator = el.querySelector('.sort-indicator');
        if (!indicator) return;

        if (sortBy === key) {
          indicator.innerHTML = `<i data-lucide="${sortOrder === 'asc' ? 'chevron-up' : 'chevron-down'}" class="w-3.5 h-3.5 inline"></i>`;
          el.classList.add('text-jet-black', 'dark:text-[#c6ac8f]', 'font-extrabold');
        } else {
          indicator.innerHTML = '';
          el.classList.remove('text-jet-black', 'dark:text-[#c6ac8f]', 'font-extrabold');
        }
      });

      const colHeader = document.getElementById('col-sort-name')?.parentElement;
      if (window.lucide && colHeader) window.lucide.createIcons({ root: colHeader });
    },

    updateFooterStatus(text) {
      if (this.elements.footerStatus) {
        this.elements.footerStatus.innerText = text;
      }
    },

    setLoading(loading) {
      const state = window.Trove.state || {};
      state.isLoading = loading;
      if (this.elements.refreshBtn) {
        this.elements.refreshBtn.disabled = loading;
        const icon = this.elements.refreshBtn.querySelector('i, svg');
        if (icon) {
          if (loading) icon.classList.add('animate-spin');
          else icon.classList.remove('animate-spin');
        }
      }
      if (this.elements.mobileRefreshBtn) {
        this.elements.mobileRefreshBtn.disabled = loading;
        const mIcon = this.elements.mobileRefreshBtn.querySelector('i, svg');
        if (mIcon) {
          if (loading) mIcon.classList.add('animate-spin');
          else mIcon.classList.remove('animate-spin');
        }
      }
      if (loading) {
        this.updateFooterStatus('Connecting to Hugging Face...');
      }
    },

    showState(iconName, title, desc, showBtn = false, btnLabel = 'Retry', onBtnClick = null, spin = false) {
      if (this.elements.fileList) this.elements.fileList.style.display = 'none';
      if (this.elements.explorerState) {
        this.elements.explorerState.style.display = 'flex';
        this.elements.stateIcon.innerHTML = `<i data-lucide="${iconName}" class="w-10 h-10 ${spin ? 'animate-spin' : ''}"></i>`;
        this.elements.stateTitle.innerText = title;
        this.elements.stateDesc.innerText = desc;

        if (showBtn) {
          this.elements.stateActionBtn.classList.remove('hidden');
          this.elements.stateActionBtn.innerText = btnLabel;
          this.elements.stateActionBtn.onclick = onBtnClick;
        } else {
          this.elements.stateActionBtn.classList.add('hidden');
          this.elements.stateActionBtn.onclick = null;
        }
      }

      if (window.lucide && this.elements.explorerState) {
        window.lucide.createIcons({ root: this.elements.explorerState });
      }
    },

    hideState() {
      if (this.elements.explorerState) this.elements.explorerState.style.display = 'none';
      if (this.elements.fileList) this.elements.fileList.style.display = '';
    },

    async fetchHFTree(token) {
      const isBucket = repo.isBucket !== false;
      const candidateUrls = isBucket ? [
        `${api.bucketsBase}/${repo.id}/tree?recursive=true`,
        `${api.bucketsBase}/${repo.id}/tree/?recursive=true`,
        `${api.bucketsBase}/${repo.id}/tree`,
        `${api.bucketsBase}/${repo.id}`
      ] : [
        `${api.datasetsBase}/${repo.id}/tree/${repo.branch || 'main'}?recursive=true`,
        `${api.datasetsBase}/${repo.id}`
      ];

      let lastError = null;

      for (const baseUrl of candidateUrls) {
        try {
          let url = baseUrl;
          const results = [];

          while (url) {
            const response = await fetch(url, {
              headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!response.ok) {
              if (response.status === 401 || response.status === 403) throw new Error('AUTH_ERROR');
              if (response.status === 404) throw new Error('NOT_FOUND');
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            if (Array.isArray(data)) {
              results.push(...data);
            } else if (data.items && Array.isArray(data.items)) {
              results.push(...data.items);
            } else if (data.entries && Array.isArray(data.entries)) {
              results.push(...data.entries);
            } else if (data.files && Array.isArray(data.files)) {
              results.push(...data.files);
            } else if (data.siblings && Array.isArray(data.siblings)) {
              results.push(...data.siblings.map(s => ({
                type: 'file',
                path: s.rfilename,
                size: s.size || 0
              })));
            }

            const linkHeader = response.headers.get('Link');
            url = null;
            if (linkHeader) {
              const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
              if (match) url = match[1];
            }
          }

          if (results.length > 0 || baseUrl === candidateUrls[0]) {
            return results;
          }
        } catch (err) {
          lastError = err;
          if (err.message === 'AUTH_ERROR') throw err;
        }
      }

      if (lastError) throw lastError;
      return [];
    },

    async fetchHFSiblingsFallback(token) {
      const isBucket = repo.isBucket !== false;
      const url = isBucket
        ? `${api.bucketsBase}/${repo.id}`
        : `${api.datasetsBase}/${repo.id}`;

      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error('AUTH_ERROR');
        if (response.status === 404) throw new Error('NOT_FOUND');
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (data.siblings && Array.isArray(data.siblings)) {
        return data.siblings.map(s => ({
          type: 'file',
          path: s.rfilename,
          size: s.size || 0
        }));
      }
      if (Array.isArray(data)) return data;
      return [];
    },

    async fetchDownloadsManifest(token) {
      const isBucket = repo.isBucket !== false;
      const candidateUrls = isBucket ? [
        `https://huggingface.co/buckets/${repo.id}/raw/downloads.json`,
        `https://huggingface.co/buckets/${repo.id}/resolve/downloads.json`,
        `${api.bucketsBase}/${repo.id}/raw/downloads.json`,
        `${api.bucketsBase}/${repo.id}/resolve/downloads.json`,
        `https://huggingface.co/api/buckets/${repo.id}/raw/downloads.json`
      ] : [
        `https://huggingface.co/datasets/${repo.id}/raw/${repo.branch || 'main'}/downloads.json`,
        `https://huggingface.co/datasets/${repo.id}/resolve/${repo.branch || 'main'}/downloads.json`,
        `${api.datasetsBase}/${repo.id}/raw/${repo.branch || 'main'}/downloads.json`
      ];

      for (const url of candidateUrls) {
        try {
          const res = await fetch(url, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {}
          });
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) return data;
            if (data && Array.isArray(data.downloads)) return data.downloads;
          }
        } catch (_) {}
      }
      return [];
    },

    async loadRepository(forceRefresh = false) {
      const state = window.Trove.state || {};
      const player = window.Trove.player || {};

      if (!state.token) {
        if (window.Trove.settings) {
          window.Trove.settings.open('Please enter your Hugging Face Token to view this private vault.');
        }
        return;
      }

      if (!forceRefresh && window.Trove.store) {
        const cached = window.Trove.store.getCachedFSTree();
        const cachedItems = cached ? (Array.isArray(cached) ? cached : cached.items) : null;
        if (cachedItems && Array.isArray(cachedItems) && cachedItems.length > 0) {
          const cachedManifest = (cached && cached.manifest) ? cached.manifest : [];
          state.downloadsManifest = cachedManifest;
          state.downloadsMap = new Map();
          if (Array.isArray(cachedManifest)) {
            cachedManifest.forEach(entry => {
              if (!entry) return;
              if (entry.filename) state.downloadsMap.set(entry.filename, entry);
              if (entry.path) state.downloadsMap.set(entry.path, entry);
              if (entry.id) state.downloadsMap.set(entry.id, entry);
            });
          }

          state.allItems = this.normalizeFileEntries(cachedItems);
          this.updateStats();
          const fileCount = state.allItems.filter(i => !i.isDir).length;
          this.updateFooterStatus(`Loaded ${fileCount} files (cached)`);
          if (player.currentTrack && typeof player.updateQueue === 'function') {
            player.updateQueue(player.currentTrack);
          }
          this.setLoading(false);
          this.render(true);
          return;
        }
      }

      this.setLoading(true);
      state.error = null;
      this.render();

      try {
        const manifestPromise = this.fetchDownloadsManifest(state.token);
        let rawItems = [];
        try {
          rawItems = await this.fetchHFTree(state.token);
        } catch (treeErr) {
          if (treeErr.message === 'AUTH_ERROR') throw treeErr;
          console.warn('Tree API endpoint failed, trying repository fallback...', treeErr);
          rawItems = await this.fetchHFSiblingsFallback(state.token);
        }

        const manifest = await manifestPromise;
        state.downloadsManifest = manifest;
        state.downloadsMap = new Map();
        if (Array.isArray(manifest)) {
          manifest.forEach(entry => {
            if (!entry) return;
            if (entry.filename) state.downloadsMap.set(entry.filename, entry);
            if (entry.path) state.downloadsMap.set(entry.path, entry);
            if (entry.id) state.downloadsMap.set(entry.id, entry);
          });
        }

        state.allItems = this.normalizeFileEntries(rawItems);
        if (window.Trove.store) {
          window.Trove.store.setCachedFSTree(rawItems, manifest);
        }

        this.updateStats();
        const fileCount = state.allItems.filter(i => !i.isDir).length;
        this.updateFooterStatus(`Loaded ${fileCount} files${forceRefresh ? ' (refreshed)' : ''}`);

        if (player.currentTrack && typeof player.updateQueue === 'function') {
          player.updateQueue(player.currentTrack);
        }

        // Check if there is a pending auto-play track
        if (state.pendingAutoPlayId) {
          const autoId = state.pendingAutoPlayId;
          const autoTitle = (state.pendingAutoPlayTitle || '').toLowerCase();
          state.pendingAutoPlayId = null;
          state.pendingAutoPlayTitle = null;

          const found = state.allItems.find(item => {
            if (item.isDir) return false;
            if (item.name.includes(autoId)) return true;
            if (autoTitle && item.name.toLowerCase().includes(autoTitle.slice(0, 15))) return true;
            return false;
          });

          if (found && player.playTrack) {
            if (window.Trove.utils?.showToast) {
              window.Trove.utils.showToast(`Now Playing newly imported: ${found.name.replace(/\.[a-zA-Z0-9]+$/, '')}`);
            }
            player.playTrack(found);
          }
        }
      } catch (err) {
        console.error('Failed to load dataset:', err);
        if (err.message === 'AUTH_ERROR') {
          state.error = `Unauthorized (401/403): Invalid token or insufficient permissions for ${repo.id}.`;
          if (window.Trove.settings) window.Trove.settings.open(state.error);
        } else if (err.message === 'NOT_FOUND' || err.message.includes('404')) {
          state.error = `Bucket not found (404). For private buckets, Hugging Face returns 404 if your token lacks access to ${repo.id}.`;
          if (window.Trove.settings) window.Trove.settings.open(state.error);
        } else {
          state.error = err.message || 'Failed to fetch repository files.';
        }
        this.updateFooterStatus('Error loading repository');
      } finally {
        this.setLoading(false);
        this.render(true);
      }
    },

    normalizeFileEntries(rawItems) {
      const state = window.Trove.state || {};
      const itemsMap = new Map();

      rawItems.forEach(item => {
        const rawPath = item.path || item.key || item.Key || item.name || '';
        if (!rawPath || rawPath.startsWith('.git/')) return;

        const cleanPath = rawPath.replace(/^\/+|\/+$/g, '');
        if (!cleanPath) return;

        const isDir = item.type === 'directory' || item.type === 'folder' || rawPath.endsWith('/');
        const size = item.size ?? item.Size ?? (item.lfs ? item.lfs.size : 0) ?? 0;
        const fileInfo = getFileInfo(cleanPath, isDir);

        const pathParts = cleanPath.split('/');
        const name = pathParts[pathParts.length - 1];
        const parentDir = pathParts.slice(0, -1).join('/');

        const manifestEntry = state.downloadsMap?.get(name) || state.downloadsMap?.get(cleanPath);
        const ingestedAt = manifestEntry?.ingested_at 
          ? (manifestEntry.ingested_at < 1e11 ? manifestEntry.ingested_at * 1000 : manifestEntry.ingested_at) 
          : null;

        itemsMap.set(cleanPath, {
          path: cleanPath,
          name: name,
          parentDir: parentDir,
          isDir: isDir,
          size: size,
          category: fileInfo.category,
          label: fileInfo.label,
          ext: fileInfo.ext,
          icon: fileInfo.icon,
          ingestedAt: ingestedAt,
          ingestedAtIso: manifestEntry?.ingested_at_iso || null,
          artist: manifestEntry?.artist || '',
          duration: manifestEntry?.duration || '',
          durationSeconds: manifestEntry?.duration_seconds || 0,
          youtubeUrl: manifestEntry?.youtube_url || '',
          thumbnailUrl: manifestEntry?.thumbnail_url || '',
          tags: manifestEntry?.tags || [],
          genre: manifestEntry?.genre || ''
        });

        for (let i = 0; i < pathParts.length - 1; i++) {
          const dirPath = pathParts.slice(0, i + 1).join('/');
          const dirName = pathParts[i];
          const dirParent = pathParts.slice(0, i).join('/');

          if (!itemsMap.has(dirPath)) {
            itemsMap.set(dirPath, {
              path: dirPath,
              name: dirName,
              parentDir: dirParent,
              isDir: true,
              size: 0,
              category: 'folder',
              label: 'Folder',
              ext: '',
              icon: 'folder'
            });
          }
        }
      });

      return Array.from(itemsMap.values());
    },

    sortItems(items) {
      const state = window.Trove.state || {};
      const sortBy = state.sortBy || 'name';
      const isDesc = state.sortOrder === 'desc';

      return items.slice().sort((a, b) => {
        // In Tree mode, folders always appear on top unless searching
        if (state.viewMode === 'tree' && !state.searchQuery) {
          if (a.isDir && !b.isDir) return -1;
          if (!a.isDir && b.isDir) return 1;
          if (a.isDir && b.isDir) return a.name.localeCompare(b.name);
        }

        let diff = 0;
        if (sortBy === 'size') {
          diff = (a.size || 0) - (b.size || 0);
          if (diff === 0) diff = a.name.localeCompare(b.name);
        } else if (sortBy === 'date') {
          const aTime = a.ingestedAt || 0;
          const bTime = b.ingestedAt || 0;
          diff = aTime - bTime;
          if (diff === 0) diff = a.name.localeCompare(b.name);
        } else {
          // Default: name
          diff = a.name.localeCompare(b.name);
        }

        return isDesc ? -diff : diff;
      });
    },

    updateStats() {
      const state = window.Trove.state || {};
      const filesOnly = (state.allItems || []).filter(item => !item.isDir && item.name !== '.gitattributes' && item.name !== '.trove_status.json');
      const musicFiles = filesOnly.filter(item => item.category === 'music');
      const videoFiles = filesOnly.filter(item => item.category === 'video');
      const totalBytes = filesOnly.reduce((acc, item) => acc + (item.size || 0), 0);

      if (this.elements.statTotalFiles) this.elements.statTotalFiles.innerText = filesOnly.length.toLocaleString();
      if (this.elements.statMusicCount) this.elements.statMusicCount.innerText = musicFiles.length.toLocaleString();
      if (this.elements.statVideoCount) this.elements.statVideoCount.innerText = videoFiles.length.toLocaleString();
      if (this.elements.statTotalSize) this.elements.statTotalSize.innerText = formatBytes(totalBytes);
    },

    getDisplayItems() {
      const state = window.Trove.state || {};
      let items = state.allItems || [];

      if (this.filterDownloaded && this.downloadedPaths) {
        const dlSet = new Set(this.downloadedPaths);
        items = items.filter(i => {
          if (i.isDir) return true;
          return dlSet.has(i.path);
        });
      }

      if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        items = items.filter(i => !i.isDir && i.name !== '.gitattributes' && i.name !== '.trove_status.json' && i.path.toLowerCase().includes(q));
        if (state.filterType !== 'all') {
          items = items.filter(i => i.category === state.filterType || (i.ext && i.ext.toLowerCase() === state.filterType));
        }
        return this.sortItems(items);
      }

      if (state.viewMode === 'flat') {
        items = items.filter(i => !i.isDir && i.name !== '.gitattributes' && i.name !== '.trove_status.json');
        if (state.filterType !== 'all') {
          items = items.filter(i => i.category === state.filterType || (i.ext && i.ext.toLowerCase() === state.filterType));
        }
        return this.sortItems(items);
      }

      // Tree mode
      const current = state.currentDirectory || '';
      const directChildren = items.filter(i => i.parentDir === current && i.name !== '.gitattributes' && i.name !== '.trove_status.json');

      let filteredChildren = directChildren;
      if (state.filterType !== 'all') {
        filteredChildren = directChildren.filter(i => i.isDir || i.category === state.filterType || (i.ext && i.ext.toLowerCase() === state.filterType));
      }

      if (this.filterDownloaded && this.downloadedPaths) {
        const dlSet = new Set(this.downloadedPaths);
        filteredChildren = filteredChildren.filter(i => {
          if (!i.isDir) return dlSet.has(i.path);
          const prefix = i.path + '/';
          for (const p of dlSet) {
            if (p.startsWith(prefix)) return true;
          }
          return false;
        });
      }

      return this.sortItems(filteredChildren);
    },

    renderItemHtml(item, isCurrentActive = false) {
      const state = window.Trove.state || {};
      const player = window.Trove.player || {};
      const isFolder = item.isDir;
      const isPlayable = !isFolder && (item.category === 'music' || item.category === 'video');

      const pathSub = state.viewMode === 'flat' || state.searchQuery 
        ? item.path 
        : (item.isDir ? 'Folder' : '');

      let badgeClasses = 'bg-gray-100 text-stone-brown dark:bg-[#242a38] dark:text-[#9aa4b2]';
      let iconColor = 'bg-almond-cream/40 text-stone-brown dark:bg-[#202532] dark:text-[#c6ac8f]';

      if (item.category === 'music') {
        badgeClasses = 'bg-almond-cream text-stone-brown dark:bg-[#242a38] dark:text-[#c6ac8f]';
        iconColor = isCurrentActive 
          ? 'bg-jet-black text-almond-cream dark:bg-[#c6ac8f] dark:text-[#0e1116]' 
          : 'bg-almond-cream text-stone-brown dark:bg-[#202532] dark:text-[#c6ac8f]';
      } else if (item.category === 'video') {
        badgeClasses = 'bg-jet-black text-almond-cream dark:bg-[#323846] dark:text-[#f3f4f6]';
        iconColor = 'bg-jet-black text-almond-cream dark:bg-[#323846] dark:text-[#f3f4f6]';
      } else if (item.category === 'folder') {
        badgeClasses = 'bg-almond-cream/60 text-stone-brown dark:bg-[#202532] dark:text-[#9aa4b2]';
        iconColor = 'bg-almond-cream/60 text-stone-brown dark:bg-[#202532] dark:text-[#c6ac8f]';
      } else if (item.category === 'document') {
        badgeClasses = 'bg-khaki-beige/35 text-jet-black font-semibold dark:bg-[#2a303e] dark:text-[#d4bfa6]';
        iconColor = 'bg-khaki-beige/25 text-stone-brown dark:bg-[#242a38] dark:text-[#c6ac8f]';
      } else if (item.category === 'image') {
        badgeClasses = 'bg-amber-100 text-amber-900 font-semibold dark:bg-[#382d1c] dark:text-[#fbbf24]';
        iconColor = 'bg-amber-50 text-amber-800 dark:bg-[#2d2516] dark:text-[#fbbf24]';
      }

      const activeRowClass = isCurrentActive 
        ? 'bg-almond-cream/40 dark:bg-[#202736] border-l-4 border-l-jet-black dark:border-l-[#c6ac8f] font-medium' 
        : 'bg-white dark:bg-[#15181f] hover:bg-almond-cream/15 dark:hover:bg-[#1a1f28]';

      let thumbSlotHtml = '';
      if (isPlayable) {
        const cachedThumb = player.thumbnailCache?.get(item.path);
        const iconName = (isCurrentActive && player.isPlaying) ? 'volume-2' : (item.icon || 'music');
        thumbSlotHtml = `
          <div class="w-9 h-9 rounded-lg ${iconColor} flex items-center justify-center shrink-0 relative overflow-hidden list-thumb-slot shadow-sm" data-file-path="${escapeHtml(item.path)}">
            <img class="w-full h-full object-contain list-thumb-img ${cachedThumb ? '' : 'hidden'}" ${cachedThumb ? `src="${cachedThumb}"` : ''} alt="Thumbnail">
            <div class="list-thumb-icon-wrapper flex items-center justify-center ${cachedThumb ? 'hidden' : ''}">
              ${getRowSvg(iconName)}
            </div>
          </div>
        `;
      } else {
        thumbSlotHtml = `
          <div class="w-9 h-9 rounded-lg ${iconColor} flex items-center justify-center shrink-0 relative overflow-hidden shadow-sm">
            ${getRowSvg(item.icon || 'file')}
          </div>
        `;
      }

      const isFav = isPlayable && window.Trove.utils?.isFavorite ? window.Trove.utils.isFavorite(item.path) : false;
      const favBtnHtml = isPlayable ? `
        <button type="button" class="btn-row-favorite p-1.5 sm:p-2 rounded-xl hover:bg-almond-cream/60 dark:hover:bg-[#252b37] ${isFav ? 'text-rose-500 dark:text-rose-400' : 'text-stone-brown/40 dark:text-[#758092] hover:text-rose-500'} transition shrink-0 min-w-[34px] min-h-[34px] flex items-center justify-center select-none" title="${isFav ? 'Remove from Liked Songs' : 'Add to Liked Songs'}" data-path="${escapeHtml(item.path)}">
          ${isFav ? getRowSvg('heartFilled') : getRowSvg('heart')}
        </button>
      ` : '';

      const actionBtnHtml = isPlayable ? `
        ${favBtnHtml}
        <button type="button" class="btn-add-to-playlist p-1.5 sm:p-2 rounded-xl hover:bg-almond-cream/60 dark:hover:bg-[#252b37] text-stone-brown/70 hover:text-jet-black dark:text-[#9aa4b2] dark:hover:text-[#f3f4f6] transition shrink-0 min-w-[34px] min-h-[34px] flex items-center justify-center select-none" title="Add to Playlist or Queue" data-path="${escapeHtml(item.path)}">
          ${getRowSvg('list-plus')}
        </button>
      ` : '';

      return `
        <div class="file-row-wrapper relative overflow-hidden bg-white dark:bg-[#15181f] select-none ${isCurrentActive ? 'is-playing-active' : ''}" data-file-path="${escapeHtml(item.path)}">
          <div class="file-row relative bg-white dark:bg-[#15181f] grid grid-cols-12 items-center px-3 py-2.5 sm:px-4 sm:py-3 transition text-sm cursor-pointer select-none ${activeRowClass}" data-path="${escapeHtml(item.path)}" data-is-dir="${isFolder}" title="${escapeHtml(item.name)} (${isFolder ? 'Folder' : (isPlayable ? 'Click to play' : 'Click to open in new tab')})">
            <div class="col-span-8 md:col-span-8 flex items-center gap-2.5 sm:gap-3 min-w-0 pr-1">
              ${thumbSlotHtml}
              <div class="flex flex-col min-w-0 flex-1">
                <span class="file-name-span font-semibold text-black dark:text-[#f3f4f6] truncate ${isCurrentActive ? 'text-jet-black dark:text-white' : ''}">${escapeHtml(item.name)}</span>
                ${pathSub ? `<span class="font-mono text-[11px] text-stone-brown/60 dark:text-[#758092] truncate">${escapeHtml(pathSub)}</span>` : ''}
              </div>
            </div>
            <div class="col-span-4 md:col-span-4 flex items-center justify-end gap-1.5 sm:gap-2 min-w-0">
              <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold font-mono uppercase ${badgeClasses} shrink-0">
                ${escapeHtml(item.label)}
              </span>
              ${!isFolder ? `<span class="font-mono text-xs text-stone-brown dark:text-[#9aa4b2] shrink-0 whitespace-nowrap">${formatBytes(item.size)}</span>` : ''}
              ${actionBtnHtml}
            </div>
          </div>
        </div>
      `;
    },

    ensureContainerStructure() {
      if (!this.elements.fileList) return;
      if (!this.elements.itemsContainer || !this.elements.fileList.contains(this.elements.itemsContainer)) {
        this.elements.fileList.innerHTML = `
          <div id="virtual-parent-dir"></div>
          <div id="virtual-spacer-top" style="height: 0px; pointer-events: none;"></div>
          <div id="virtual-items-container" class="divide-y divide-almond-cream/60 dark:divide-[#202530]"></div>
          <div id="virtual-spacer-bottom" style="height: 0px; pointer-events: none;"></div>
        `;
        this.elements.virtualParentDir = document.getElementById('virtual-parent-dir');
        this.elements.topSpacer = document.getElementById('virtual-spacer-top');
        this.elements.itemsContainer = document.getElementById('virtual-items-container');
        this.elements.bottomSpacer = document.getElementById('virtual-spacer-bottom');
      }
    },

    render(resetScroll = false) {
      const state = window.Trove.state || {};

      if (state.isLoading) {
        this.showState('loader-2', 'Loading Repository', 'Connecting to Hugging Face dataset tree...', false, '', null, true);
        if (this.elements.itemsContainer) this.elements.itemsContainer.innerHTML = '';
        if (this.elements.topSpacer) this.elements.topSpacer.style.height = '0px';
        if (this.elements.bottomSpacer) this.elements.bottomSpacer.style.height = '0px';
        return;
      }

      if (state.error) {
        this.showState(
          'alert-circle',
          'Connection Error',
          state.error,
          true,
          'Enter Token / Retry',
          () => { if (window.Trove.settings) window.Trove.settings.open(); }
        );
        if (this.elements.itemsContainer) this.elements.itemsContainer.innerHTML = '';
        if (this.elements.topSpacer) this.elements.topSpacer.style.height = '0px';
        if (this.elements.bottomSpacer) this.elements.bottomSpacer.style.height = '0px';
        return;
      }

      this.renderBreadcrumbs();

      this.currentDisplayItems = this.getDisplayItems();

      if (this.currentDisplayItems.length === 0) {
        this.ensureContainerStructure();
        if (this.elements.itemsContainer) this.elements.itemsContainer.innerHTML = '';
        if (this.elements.virtualParentDir) this.elements.virtualParentDir.innerHTML = '';
        if (this.elements.topSpacer) this.elements.topSpacer.style.height = '0px';
        if (this.elements.bottomSpacer) this.elements.bottomSpacer.style.height = '0px';
        const filterLabel = FILTER_CONFIG[state.filterType]?.fullLabel || state.filterType;
        const message = state.searchQuery
          ? `No files matching "${state.searchQuery}"`
          : state.filterType !== 'all'
          ? `No ${filterLabel} files found here.`
          : 'This folder is empty.';
        this.showState('inbox', 'No Files Found', message, false);
        return;
      }

      this.hideState();
      this.ensureContainerStructure();

      if (resetScroll && this.elements.fileList) {
        this.elements.fileList.scrollTop = 0;
      }

      // Render parent directory item if in tree view and inside a subfolder
      if (this.elements.virtualParentDir) {
        if (state.viewMode === 'tree' && state.currentDirectory !== '' && !state.searchQuery) {
          this.elements.virtualParentDir.innerHTML = `
            <div class="file-row-wrapper relative overflow-hidden bg-white dark:bg-[#15181f] select-none border-b border-almond-cream/60 dark:border-[#202530]">
              <div class="grid grid-cols-12 items-center px-3 py-2.5 sm:px-4 sm:py-3 hover:bg-almond-cream/20 dark:hover:bg-[#1a1f28] cursor-pointer transition text-sm" data-action="go-parent">
                <div class="col-span-8 md:col-span-8 flex items-center gap-2.5 sm:gap-3 min-w-0 pr-1">
                  <div class="w-9 h-9 rounded-lg bg-almond-cream/60 dark:bg-[#202532] text-stone-brown dark:text-[#c6ac8f] flex items-center justify-center shrink-0">
                    ${getRowSvg('corner-left-up')}
                  </div>
                  <div class="flex flex-col min-w-0 flex-1">
                    <span class="font-semibold text-black dark:text-[#f3f4f6] truncate">..</span>
                    <span class="font-mono text-[11px] text-stone-brown/60 dark:text-[#758092] truncate">Parent Directory</span>
                  </div>
                </div>
                <div class="col-span-4 md:col-span-4 flex items-center justify-end pr-1 sm:pr-2">
                  <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold font-mono uppercase bg-almond-cream/60 dark:bg-[#242a38] text-stone-brown dark:text-[#c6ac8f]">UP</span>
                </div>
              </div>
            </div>
          `;
        } else {
          this.elements.virtualParentDir.innerHTML = '';
        }
      }

      // Reset window indices and recalculate virtual window
      this.virtualStartIndex = -1;
      this.virtualEndIndex = -1;
      this.updateVirtualWindow(true);
    },

    updateVirtualWindow(force = false) {
      if (!this.elements.fileList) return;
      const total = (this.currentDisplayItems || []).length;
      if (total === 0) return;

      this.ensureContainerStructure();

      const state = window.Trove.state || {};
      const isFlatOrSearch = state.viewMode === 'flat' || Boolean(state.searchQuery);
      const rowHeight = isFlatOrSearch ? 64 : 58;
      this.rowHeight = rowHeight;

      const scrollTop = Math.max(0, this.elements.fileList.scrollTop);
      const viewportHeight = this.elements.fileList.clientHeight || 600;

      const firstVisible = Math.floor(scrollTop / rowHeight);
      const visibleCount = Math.ceil(viewportHeight / rowHeight);

      const startIndex = Math.max(0, firstVisible - this.bufferSize);
      const endIndex = Math.min(total, firstVisible + visibleCount + this.bufferSize);

      if (!force && startIndex === this.virtualStartIndex && endIndex === this.virtualEndIndex) {
        return;
      }

      this.virtualStartIndex = startIndex;
      this.virtualEndIndex = endIndex;

      const topHeight = startIndex * rowHeight;
      const bottomHeight = (total - endIndex) * rowHeight;

      if (this.elements.topSpacer) {
        this.elements.topSpacer.style.height = `${topHeight}px`;
      }
      if (this.elements.bottomSpacer) {
        this.elements.bottomSpacer.style.height = `${bottomHeight}px`;
      }

      const player = window.Trove.player || {};
      const visibleSlice = this.currentDisplayItems.slice(startIndex, endIndex);
      let batchHtml = '';
      for (let i = 0; i < visibleSlice.length; i++) {
        const item = visibleSlice[i];
        const isCurrentActive = Boolean(player.currentTrack && player.currentTrack.path === item.path);
        batchHtml += this.renderItemHtml(item, isCurrentActive);
      }

      if (this.elements.itemsContainer) {
        this.elements.itemsContainer.innerHTML = batchHtml;
      }

      this.initListThumbnailObserver();
    },

    updateActiveTrackHighlight(newTrack) {
      if (!this.elements.fileList) return;
      const state = window.Trove.state || {};
      const player = window.Trove.player || {};

      // 1. Remove active state from currently active row(s)
      const prevActiveWrappers = this.elements.fileList.querySelectorAll('.file-row-wrapper.is-playing-active');
      prevActiveWrappers.forEach(wrap => {
        wrap.classList.remove('is-playing-active');
        const row = wrap.querySelector('.file-row');
        if (row) {
          row.classList.remove('bg-almond-cream/40', 'dark:bg-[#202736]', 'border-l-4', 'border-l-jet-black', 'dark:border-l-[#c6ac8f]', 'font-medium');
          row.classList.add('bg-white', 'dark:bg-[#15181f]', 'hover:bg-almond-cream/15', 'dark:hover:bg-[#1a1f28]');
        }
        const nameSpan = wrap.querySelector('.file-name-span');
        if (nameSpan) {
          nameSpan.classList.remove('text-jet-black', 'dark:text-white');
        }
        const iconWrap = wrap.querySelector('.list-thumb-icon-wrapper');
        const filePath = wrap.dataset.filePath;
        const itemObj = (this.currentDisplayItems || []).find(i => i.path === filePath);
        if (iconWrap && itemObj) {
          iconWrap.innerHTML = getRowSvg(itemObj.icon || 'music');
        }
      });

      // 2. Add active state to the new track's row (if rendered in DOM)
      if (newTrack && newTrack.path) {
        let newWrap = null;
        try {
          const escapedPath = CSS.escape(newTrack.path);
          newWrap = this.elements.fileList.querySelector(`.file-row-wrapper[data-file-path="${escapedPath}"]`);
        } catch (_) {}

        if (newWrap) {
          newWrap.classList.add('is-playing-active');
          const row = newWrap.querySelector('.file-row');
          if (row) {
            row.classList.remove('bg-white', 'dark:bg-[#15181f]', 'hover:bg-almond-cream/15', 'dark:hover:bg-[#1a1f28]');
            row.classList.add('bg-almond-cream/40', 'dark:bg-[#202736]', 'border-l-4', 'border-l-jet-black', 'dark:border-l-[#c6ac8f]', 'font-medium');
          }
          const nameSpan = newWrap.querySelector('.file-name-span');
          if (nameSpan) {
            nameSpan.classList.add('text-jet-black', 'dark:text-white');
          }
          const iconWrap = newWrap.querySelector('.list-thumb-icon-wrapper');
          if (iconWrap) {
            iconWrap.innerHTML = getRowSvg('volume-2');
          }
        }
      }
    },

    renderBreadcrumbs() {
      const state = window.Trove.state || {};
      if (!this.elements.breadcrumbs) return;

      if (state.viewMode === 'flat' || state.searchQuery) {
        this.elements.breadcrumbs.innerHTML = `
          <span class="font-semibold text-jet-black dark:text-[#f3f4f6]">
            ${state.searchQuery ? `Search Results: "${escapeHtml(state.searchQuery)}"` : 'All Files (Flat View)'}
          </span>
        `;
        return;
      }

      const parts = state.currentDirectory ? state.currentDirectory.split('/') : [];

      let html = `
        <div class="breadcrumb-item inline-flex items-center gap-1.5 px-2 py-1 rounded hover:bg-almond-cream/60 dark:hover:bg-[#202532] cursor-pointer transition ${parts.length === 0 ? 'font-bold text-jet-black dark:text-[#f3f4f6]' : 'text-stone-brown dark:text-[#9aa4b2]'}" data-dir="">
          <i data-lucide="folder" class="w-3.5 h-3.5"></i>
          <span>Root</span>
        </div>
      `;

      let accumulatedPath = '';
      parts.forEach((part, index) => {
        accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;
        const isLast = index === parts.length - 1;
        html += `
          <span class="text-khaki-beige dark:text-[#758092] select-none">/</span>
          <div class="breadcrumb-item px-2 py-1 rounded hover:bg-almond-cream/60 dark:hover:bg-[#202532] cursor-pointer transition ${isLast ? 'font-bold text-jet-black dark:text-[#f3f4f6]' : 'text-stone-brown dark:text-[#9aa4b2]'}" data-dir="${escapeHtml(accumulatedPath)}">
            <span>${escapeHtml(part)}</span>
          </div>
        `;
      });

      this.elements.breadcrumbs.innerHTML = html;
      if (window.lucide && this.elements.breadcrumbs) window.lucide.createIcons({ root: this.elements.breadcrumbs });
    },

    updateViewToggleUI() {
      if (!this.elements.viewToggleBtn) return;
      const state = window.Trove.state || {};
      const isTree = state.viewMode === 'tree';
      this.elements.viewToggleBtn.title = isTree 
        ? 'Current: Tree View. Click to switch to Flat View.' 
        : 'Current: Flat View. Click to switch to Tree View.';
      this.elements.viewToggleBtn.innerHTML = `<i data-lucide="${isTree ? 'folder-tree' : 'list'}" class="w-4 h-4"></i>`;
      if (window.lucide) window.lucide.createIcons({ root: this.elements.viewToggleBtn });
    },

    updateFilterDropdownUI() {
      const state = window.Trove.state || {};
      const config = FILTER_CONFIG[state.filterType] || { label: state.filterType, fullLabel: state.filterType, icon: 'filter' };
      if (this.elements.filterActiveLabel) this.elements.filterActiveLabel.innerText = config.label;
      if (this.elements.filterActiveIcon) this.elements.filterActiveIcon.setAttribute('data-lucide', config.icon);

      if (this.elements.filterDropdownMenu) {
        this.elements.filterDropdownMenu.querySelectorAll('.filter-option').forEach(opt => {
          const checkIcon = opt.querySelector('.filter-check-icon');
          const isActive = opt.dataset.filter === state.filterType;
          if (checkIcon) {
            if (isActive) checkIcon.classList.remove('hidden');
            else checkIcon.classList.add('hidden');
          }
          if (isActive) {
            opt.classList.add('bg-almond-cream/50', 'dark:bg-[#222734]', 'font-semibold');
          } else {
            opt.classList.remove('bg-almond-cream/50', 'dark:bg-[#222734]', 'font-semibold');
          }
        });
      }
      if (window.lucide && this.elements.filterDropdownBtn) {
        window.lucide.createIcons({ root: this.elements.filterDropdownBtn });
      }
    },

    initListThumbnailObserver() {
      const player = window.Trove.player || {};
      if (this.thumbnailObserver) this.thumbnailObserver.disconnect();
      if (!('IntersectionObserver' in window) || !this.elements.fileList) return;

      this.thumbnailObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          const slot = entry.target;
          if (entry.isIntersecting) {
            // Cancel any pending timer on this slot
            if (slot._thumbTimer) clearTimeout(slot._thumbTimer);
            // Wait 180ms to ensure the user paused scrolling and didn't just skim past
            slot._thumbTimer = setTimeout(() => {
              delete slot._thumbTimer;
              if (this.thumbnailObserver) {
                this.thumbnailObserver.unobserve(slot);
              }
              const path = slot.dataset.filePath;
              if (path && !player.thumbnailCache?.has(path)) {
                this.enqueueThumbnailExtraction(path);
              }
            }, 180);
          } else {
            // User skimmed past before dwelling -> cancel pending request immediately
            if (slot._thumbTimer) {
              clearTimeout(slot._thumbTimer);
              delete slot._thumbTimer;
            }
          }
        });
      }, { rootMargin: '80px', threshold: 0.05 });

      const slots = this.elements.fileList.querySelectorAll('.list-thumb-slot');
      slots.forEach(slot => {
        const path = slot.dataset.filePath;
        if (player.thumbnailCache?.has(path)) {
          const img = slot.querySelector('.list-thumb-img');
          const iconWrapper = slot.querySelector('.list-thumb-icon-wrapper');
          if (img && iconWrapper) {
            img.src = player.thumbnailCache.get(path);
            img.classList.remove('hidden');
            iconWrapper.classList.add('hidden');
          }
        } else {
          this.thumbnailObserver.observe(slot);
        }
      });
    },

    enqueueThumbnailExtraction(path) {
      const player = window.Trove.player || {};
      if (this.extractionQueue.includes(path) || player.thumbnailCache?.has(path)) return;
      this.extractionQueue.push(path);
      this.drainThumbnailQueue();
    },

    drainThumbnailQueue() {
      const CONCURRENCY = 8;
      if (typeof this.activeThumbnailWorkers !== 'number') {
        this.activeThumbnailWorkers = 0;
      }

      // Launch parallel workers up to CONCURRENCY limit
      while (this.activeThumbnailWorkers < CONCURRENCY && this.extractionQueue.length > 0) {
        this.activeThumbnailWorkers++;
        this.runThumbnailWorker();
      }
    },

    async runThumbnailWorker() {
      const player = window.Trove.player || {};
      const state = window.Trove.state || {};

      try {
        while (this.extractionQueue.length > 0) {
          const path = this.extractionQueue.shift();
          if (!path) continue;
          if (player.thumbnailCache?.has(path)) continue;
          const item = (state.allItems || []).find(i => i.path === path);
          if (!item) continue;

          try {
            // 1. Check IDB, dedicated covers/ folder, or sidecar metadata
            // WITHOUT downloading the multi-megabyte media file!
            let thumbUrl = null;
            if (typeof player.getCoverThumbnail === 'function') {
              thumbUrl = await player.getCoverThumbnail(item);
            }

            // 2. Fall back to downloading full media file ONLY if dedicated cover doesn't exist
            if (!thumbUrl) {
              const mediaEntry = await player.getMediaBlobAndUrl(item);
              if (mediaEntry && mediaEntry.blob) {
                thumbUrl = await player.extractThumbnail(mediaEntry.blob, item);
              }
            }

            if (thumbUrl && this.elements.fileList) {
              const slots = this.elements.fileList.querySelectorAll('.list-thumb-slot');
              slots.forEach(slot => {
                if (slot.dataset.filePath === path) {
                  const img = slot.querySelector('.list-thumb-img');
                  const iconWrapper = slot.querySelector('.list-thumb-icon-wrapper');
                  if (img && iconWrapper) {
                    img.src = thumbUrl;
                    img.classList.remove('hidden');
                    iconWrapper.classList.add('hidden');
                  }
                }
              });
            }
          } catch (_) {}
        }
      } finally {
        this.activeThumbnailWorkers--;
        // If items were enqueued while worker was exiting, keep the pool filled
        if (this.extractionQueue.length > 0) {
          this.drainThumbnailQueue();
        }
      }
    },

    async loadStoredThumbnails() {
      const player = window.Trove.player || {};
      try {
        const db = await getIDB();
        if (!db) return;
        const tx = db.transaction('thumbnails', 'readonly');
        const store = tx.objectStore('thumbnails');
        const req = store.getAll();
        req.onsuccess = () => {
          const records = req.result;
          if (records && Array.isArray(records)) {
            records.forEach(rec => {
              if (rec && rec.path && rec.blob && player.thumbnailCache) {
                const url = URL.createObjectURL(rec.blob);
                player.thumbnailCache.set(rec.path, url);
              }
            });
            this.refreshVisibleThumbnails();
          }
        };
      } catch (e) {
        console.warn('Could not load stored thumbnails from IndexedDB:', e);
      }
    },

    refreshVisibleThumbnails() {
      const player = window.Trove.player || {};
      if (!this.elements.fileList || !player.thumbnailCache) return;
      const slots = this.elements.fileList.querySelectorAll('.list-thumb-slot');
      slots.forEach(slot => {
        const path = slot.dataset.filePath;
        if (path && player.thumbnailCache.has(path)) {
          const img = slot.querySelector('.list-thumb-img');
          const iconWrapper = slot.querySelector('.list-thumb-icon-wrapper');
          if (img && iconWrapper) {
            img.src = player.thumbnailCache.get(path);
            img.classList.remove('hidden');
            iconWrapper.classList.add('hidden');
          }
        }
      });
    },

    setupEventListeners() {
      const state = window.Trove.state || {};
      const player = window.Trove.player || {};

      // Virtual windowed scroll listener
      if (this.elements.fileList) {
        this.elements.fileList.addEventListener('scroll', () => {
          if (this.scrollRafId) return;
          this.scrollRafId = requestAnimationFrame(() => {
            this.scrollRafId = null;
            this.updateVirtualWindow();
          });
        }, { passive: true });
      }

      if (this.elements.refreshBtn) {
        this.elements.refreshBtn.addEventListener('click', () => {
          this.loadRepository(true);
        });
      }

      if (this.elements.mobileRefreshBtn) {
        this.elements.mobileRefreshBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const mobileNav = document.getElementById('mobile-nav-menu');
          if (mobileNav) mobileNav.classList.add('hidden');
          this.loadRepository(true);
        });
      }

      // Search input & clear
      if (this.elements.searchInput) {
        this.elements.searchInput.addEventListener('input', (e) => {
          state.searchQuery = e.target.value.trim();
          if (state.searchQuery) {
            this.elements.clearSearchBtn?.classList.remove('hidden');
          } else {
            this.elements.clearSearchBtn?.classList.add('hidden');
          }
          this.render(true);
        });
      }

      if (this.elements.clearSearchBtn) {
        this.elements.clearSearchBtn.addEventListener('click', () => {
          if (this.elements.searchInput) this.elements.searchInput.value = '';
          state.searchQuery = '';
          this.elements.clearSearchBtn.classList.add('hidden');
          this.render(true);
        });
      }

      // View toggle button
      if (this.elements.viewToggleBtn) {
        this.elements.viewToggleBtn.addEventListener('click', () => {
          state.viewMode = state.viewMode === 'tree' ? 'flat' : 'tree';
          this.updateViewToggleUI();
          if (window.Trove.store) window.Trove.store.saveViewSettings();
          this.render(true);
        });
      }

      // Downloaded only filter toggle
      const btnDownloaded = document.getElementById('btn-filter-downloaded');
      if (btnDownloaded) {
        btnDownloaded.addEventListener('click', async () => {
          this.filterDownloaded = !this.filterDownloaded;
          if (this.filterDownloaded) {
            this.downloadedPaths = await window.Trove.utils.getAllDownloadedMediaPaths();
            btnDownloaded.classList.add('bg-emerald-50', 'dark:bg-emerald-950/40', 'text-emerald-700', 'dark:text-emerald-300', 'border-emerald-400', 'dark:border-emerald-600/60');
            btnDownloaded.classList.remove('text-stone-brown', 'dark:text-[#9aa4b2]', 'bg-white', 'dark:bg-[#15181f]');
          } else {
            btnDownloaded.classList.remove('bg-emerald-50', 'dark:bg-emerald-950/40', 'text-emerald-700', 'dark:text-emerald-300', 'border-emerald-400', 'dark:border-emerald-600/60');
            btnDownloaded.classList.add('text-stone-brown', 'dark:text-[#9aa4b2]', 'bg-white', 'dark:bg-[#15181f]');
          }
          this.render(true);
        });
      }

      window.addEventListener('trove:favorites-changed', () => {
        const fileList = this.elements.fileList;
        if (fileList && fileList.children.length > 0) {
          const favs = window.Trove.utils?.getFavorites ? window.Trove.utils.getFavorites() : [];
          fileList.querySelectorAll('.btn-row-favorite').forEach(btn => {
            const p = btn.dataset.path;
            const isFav = favs.includes(p);
            const icon = btn.querySelector('[data-lucide="heart"]');
            if (isFav) {
              btn.classList.add('text-rose-500', 'dark:text-rose-400');
              btn.classList.remove('text-stone-brown/40', 'dark:text-[#758092]');
              if (icon) icon.setAttribute('fill', 'currentColor');
            } else {
              btn.classList.remove('text-rose-500', 'dark:text-rose-400');
              btn.classList.add('text-stone-brown/40', 'dark:text-[#758092]');
              if (icon) icon.removeAttribute('fill');
            }
          });
        }
      });

      // Filter dropdown
      if (this.elements.filterDropdownBtn && this.elements.filterDropdownMenu) {
        this.elements.filterDropdownBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const willOpen = this.elements.filterDropdownMenu.classList.contains('hidden');
          this.elements.filterDropdownMenu.classList.toggle('hidden');
          if (willOpen && MotionAnim?.isAvailable()) {
            try {
              window.Motion.animate(
                this.elements.filterDropdownMenu,
                { opacity: [0, 1], transform: ['scale(0.96) translateY(-6px)', 'scale(1) translateY(0px)'] },
                { duration: 0.16, easing: 'ease-out' }
              );
            } catch (_) {}
          }
        });

        this.elements.filterDropdownMenu.addEventListener('click', (e) => {
          const option = e.target.closest('.filter-option');
          if (!option) return;
          state.filterType = option.dataset.filter || 'all';
          this.updateFilterDropdownUI();
          this.elements.filterDropdownMenu.classList.add('hidden');
          if (window.Trove.store) window.Trove.store.saveViewSettings();
          this.render(true);
        });

        document.addEventListener('click', (e) => {
          if (!this.elements.filterDropdownMenu.classList.contains('hidden')) {
            const container = document.getElementById('filter-dropdown-container');
            if (container && !container.contains(e.target)) {
              this.elements.filterDropdownMenu.classList.add('hidden');
            }
          }
        });
      }

      // Sort dropdown
      if (this.elements.sortDropdownBtn && this.elements.sortDropdownMenu) {
        this.elements.sortDropdownBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const willOpen = this.elements.sortDropdownMenu.classList.contains('hidden');
          this.elements.sortDropdownMenu.classList.toggle('hidden');
          if (willOpen && MotionAnim?.isAvailable()) {
            try {
              window.Motion.animate(
                this.elements.sortDropdownMenu,
                { opacity: [0, 1], transform: ['scale(0.96) translateY(-6px)', 'scale(1) translateY(0px)'] },
                { duration: 0.16, easing: 'ease-out' }
              );
            } catch (_) {}
          }
        });

        this.elements.sortDropdownMenu.addEventListener('click', (e) => {
          const option = e.target.closest('.sort-option');
          if (!option) return;
          state.sortBy = option.dataset.sort || 'name';
          state.sortOrder = option.dataset.order || 'asc';
          this.updateSortUI();
          this.elements.sortDropdownMenu.classList.add('hidden');
          if (window.Trove.store) window.Trove.store.saveViewSettings();
          this.render(true);
        });

        document.addEventListener('click', (e) => {
          if (!this.elements.sortDropdownMenu.classList.contains('hidden')) {
            const container = document.getElementById('sort-dropdown-container');
            if (container && !container.contains(e.target)) {
              this.elements.sortDropdownMenu.classList.add('hidden');
            }
          }
        });
      }

      // Column Header Clicks for Sorting
      const bindColHeaderSort = (el, sortField, defaultOrder = 'asc') => {
        if (!el) return;
        el.addEventListener('click', () => {
          if (state.sortBy === sortField) {
            state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc';
          } else {
            state.sortBy = sortField;
            state.sortOrder = defaultOrder;
          }
          this.updateSortUI();
          if (window.Trove.store) window.Trove.store.saveViewSettings();
          this.render(true);
        });
      };

      bindColHeaderSort(this.elements.colSortName, 'name', 'asc');
      bindColHeaderSort(this.elements.colSortSize, 'size', 'desc');
      bindColHeaderSort(this.elements.colSortDate, 'date', 'desc');

      // Breadcrumbs
      if (this.elements.breadcrumbs) {
        this.elements.breadcrumbs.addEventListener('click', (e) => {
          const item = e.target.closest('.breadcrumb-item');
          if (item && item.dataset.dir !== undefined) {
            state.currentDirectory = item.dataset.dir;
            if (window.Trove.store) window.Trove.store.saveViewSettings();
            this.render(true);
          }
        });
      }

      // File list clicks (folder navigation, playback, native open)
      if (this.elements.fileList) {
        this.elements.fileList.addEventListener('click', (e) => {
          const parentRow = e.target.closest('[data-action="go-parent"]');
          if (parentRow) {
            const parts = (state.currentDirectory || '').split('/');
            parts.pop();
            state.currentDirectory = parts.join('/');
            if (window.Trove.store) window.Trove.store.saveViewSettings();
            this.render(true);
            return;
          }

          const row = e.target.closest('.file-row');
          if (!row) return;

          // Quick Add to Playlist button click
          const addBtn = e.target.closest('.btn-add-to-playlist');
          if (addBtn) {
            e.stopPropagation();
            const filePath = addBtn.dataset.path;
            const item = (state.allItems || []).find(i => i.path === filePath);
            if (item && window.Trove.playlists) {
              window.Trove.playlists.openAddModal(item);
            }
            return;
          }

          // Favorite button click
          const favBtn = e.target.closest('.btn-row-favorite');
          if (favBtn) {
            e.stopPropagation();
            const filePath = favBtn.dataset.path;
            if (window.Trove.utils?.toggleFavorite) {
              const isFav = window.Trove.utils.toggleFavorite(filePath);
              if (isFav) {
                favBtn.classList.add('text-rose-500', 'dark:text-rose-400');
                favBtn.classList.remove('text-stone-brown/40', 'dark:text-[#758092]');
                favBtn.innerHTML = getRowSvg('heartFilled');
                favBtn.title = 'Remove from Liked Songs';
              } else {
                favBtn.classList.remove('text-rose-500', 'dark:text-rose-400');
                favBtn.classList.add('text-stone-brown/40', 'dark:text-[#758092]');
                favBtn.innerHTML = getRowSvg('heart');
                favBtn.title = 'Add to Liked Songs';
              }
              const item = (state.allItems || []).find(i => i.path === filePath);
              const name = (item?.name || filePath.split('/').pop()).replace(/\.[a-zA-Z0-9]+$/, '');
              if (window.Trove.utils?.showToast) {
                window.Trove.utils.showToast(isFav ? `Added "${name}" to Liked Songs` : `Removed "${name}" from Liked Songs`);
              }
            }
            return;
          }

          const isDir = row.dataset.isDir === 'true';
          const path = row.dataset.path;

          if (isDir) {
            state.currentDirectory = path;
            if (window.Trove.store) window.Trove.store.saveViewSettings();
            this.render(true);
          } else {
            const item = (state.allItems || []).find(i => i.path === path);
            if (!item) return;
            if (item.category === 'music' || item.category === 'video') {
              if (player) {
                player.isCustomContextActive = false;
                const displayPlayable = this.getDisplayItems().filter(i => !i.isDir && (i.category === 'music' || i.category === 'video'));
                player.queue = displayPlayable.length > 0 ? displayPlayable : (state.allItems || []).filter(i => !i.isDir && (i.category === 'music' || i.category === 'video'));
                player.currentIndex = player.queue.findIndex(i => i.path === item.path);
                if (typeof player.playTrack === 'function') player.playTrack(item);
              }
            } else {
              const encodedPath = item.path.split('/').map(seg => encodeURIComponent(seg)).join('/');
              const fileUrl = `https://huggingface.co/buckets/${repo.id}/resolve/${encodedPath}`;
              window.open(fileUrl, '_blank', 'noopener,noreferrer');
            }
          }
        });
      }
    }
  };

  // Export
  window.Trove.explorer = ExplorerManager;
  window.loadRepository = (refresh) => ExplorerManager.loadRepository(refresh);
  window.render = () => ExplorerManager.render();
})();

