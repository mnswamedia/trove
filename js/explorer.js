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

  const ExplorerManager = {
    elements: {},
    thumbnailObserver: null,
    extractionQueue: [],
    isExtractingQueue: false,

    init() {
      this.elements = {
        fileList: document.getElementById('file-list'),
        breadcrumbs: document.getElementById('breadcrumbs'),
        refreshBtn: document.getElementById('refresh-btn'),
        searchInput: document.getElementById('search-input'),
        clearSearchBtn: document.getElementById('clear-search-btn'),
        viewToggleBtn: document.getElementById('view-toggle-btn'),
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

      if (window.lucide) window.lucide.createIcons();
    },

    updateFooterStatus(text) {
      if (this.elements.footerStatus) {
        this.elements.footerStatus.innerText = text;
      }
    },

    setLoading(loading) {
      const state = window.Trove.state || {};
      state.isLoading = loading;
      if (this.elements.refreshBtn) this.elements.refreshBtn.disabled = loading;
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

      if (window.lucide) window.lucide.createIcons();
    },

    hideState() {
      if (this.elements.explorerState) this.elements.explorerState.style.display = 'none';
      if (this.elements.fileList) this.elements.fileList.style.display = 'block';
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
          this.render();
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
        this.render();
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

      return this.sortItems(filteredChildren);
    },

    render() {
      const state = window.Trove.state || {};
      const player = window.Trove.player || {};

      if (state.isLoading) {
        this.showState('loader-2', 'Loading Repository', 'Connecting to Hugging Face dataset tree...', false, '', null, true);
        if (this.elements.fileList) this.elements.fileList.innerHTML = '';
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
        if (this.elements.fileList) this.elements.fileList.innerHTML = '';
        return;
      }

      this.renderBreadcrumbs();

      const items = this.getDisplayItems();

      if (items.length === 0) {
        if (this.elements.fileList) this.elements.fileList.innerHTML = '';
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

      let html = '';

      if (state.viewMode === 'tree' && state.currentDirectory !== '' && !state.searchQuery) {
        html += `
          <div class="grid grid-cols-12 items-center px-4 py-2.5 hover:bg-almond-cream/20 dark:hover:bg-[#1a1f28] cursor-pointer transition text-sm" data-action="go-parent">
            <div class="col-span-7 md:col-span-6 flex items-center gap-3 min-w-0">
              <div class="w-8 h-8 rounded-lg bg-almond-cream/60 dark:bg-[#202532] text-stone-brown dark:text-[#c6ac8f] flex items-center justify-center shrink-0">
                <i data-lucide="corner-left-up" class="w-4 h-4"></i>
              </div>
              <div class="flex flex-col min-w-0">
                <span class="font-semibold text-black dark:text-[#f3f4f6] truncate">..</span>
                <span class="font-mono text-[11px] text-stone-brown/60 dark:text-[#758092] truncate">Parent Directory</span>
              </div>
            </div>
            <div class="col-span-2 md:col-span-2">
              <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold font-mono uppercase bg-almond-cream/60 dark:bg-[#242a38] text-stone-brown dark:text-[#c6ac8f]">UP</span>
            </div>
            <div class="col-span-3 md:col-span-2 font-mono text-xs text-stone-brown/60 dark:text-[#758092] text-right md:text-left">--</div>
            <div class="hidden md:block col-span-2 text-xs text-stone-brown/60 dark:text-[#758092]">Directory</div>
          </div>
        `;
      }

      items.forEach(item => {
        const isFolder = item.isDir;
        const isPlayable = !isFolder && (item.category === 'music' || item.category === 'video');
        const isCurrentActive = player.currentTrack && player.currentTrack.path === item.path;

        const pathSub = state.viewMode === 'flat' || state.searchQuery 
          ? item.path 
          : (item.isDir ? 'Folder' : (item.ext ? `.${item.ext}` : ''));

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
          ? 'bg-almond-cream/30 dark:bg-[#202736] border-l-4 border-l-jet-black dark:border-l-[#c6ac8f] font-medium' 
          : 'hover:bg-almond-cream/15 dark:hover:bg-[#1a1f28]';

        let thumbSlotHtml = '';
        if (isPlayable) {
          const cachedThumb = player.thumbnailCache?.get(item.path);
          thumbSlotHtml = `
            <div class="w-9 h-9 rounded-lg ${iconColor} flex items-center justify-center shrink-0 relative overflow-hidden list-thumb-slot shadow-sm" data-file-path="${escapeHtml(item.path)}">
              <img class="w-full h-full object-contain list-thumb-img ${cachedThumb ? '' : 'hidden'}" ${cachedThumb ? `src="${cachedThumb}"` : ''} alt="Thumbnail">
              <div class="list-thumb-icon-wrapper flex items-center justify-center ${cachedThumb ? 'hidden' : ''}">
                <i data-lucide="${isCurrentActive && player.isPlaying ? 'volume-2' : item.icon}" class="w-4 h-4"></i>
              </div>
            </div>
          `;
        } else {
          thumbSlotHtml = `
            <div class="w-9 h-9 rounded-lg ${iconColor} flex items-center justify-center shrink-0 relative overflow-hidden shadow-sm">
              <i data-lucide="${item.icon}" class="w-4 h-4"></i>
            </div>
          `;
        }

        const statusText = isFolder 
          ? 'Folder' 
          : (isPlayable ? (isCurrentActive ? 'Playing Now' : 'Click to Play') : 'Click to Open ↗');

        let displayStatus = statusText;
        let dateTooltip = '';
        if (isCurrentActive && isPlayable) {
          displayStatus = 'Playing Now';
        } else if (!isFolder && item.ingestedAt) {
          displayStatus = formatRelativeTime(item.ingestedAt);
          dateTooltip = `Downloaded: ${item.ingestedAtIso || new Date(item.ingestedAt).toLocaleString()}`;
        }

        const actionBtnHtml = isPlayable ? `
          <button type="button" class="btn-add-to-playlist p-1.5 rounded-lg hover:bg-almond-cream/60 dark:hover:bg-[#252b37] text-stone-brown/70 hover:text-jet-black dark:text-[#9aa4b2] dark:hover:text-[#f3f4f6] transition shrink-0 ml-1" title="Add to Playlist or Queue" data-path="${escapeHtml(item.path)}">
            <i data-lucide="list-plus" class="w-4 h-4"></i>
          </button>
        ` : '';

        html += `
          <div class="file-row grid grid-cols-12 items-center px-3 py-2.5 sm:px-4 sm:py-3 transition text-sm cursor-pointer ${activeRowClass}" data-path="${escapeHtml(item.path)}" data-is-dir="${isFolder}" title="${escapeHtml(item.name)} (${isFolder ? 'Folder' : (isPlayable ? 'Click to play' : 'Click to open in new tab')})">
            <div class="col-span-6 md:col-span-6 flex items-center gap-2.5 sm:gap-3 min-w-0">
              ${thumbSlotHtml}
              <div class="flex flex-col min-w-0">
                <span class="font-semibold text-black dark:text-[#f3f4f6] truncate ${isCurrentActive ? 'text-jet-black dark:text-white' : ''}">${escapeHtml(item.name)}</span>
                <span class="font-mono text-[11px] text-stone-brown/60 dark:text-[#758092] truncate">${escapeHtml(pathSub)}</span>
              </div>
            </div>
            <div class="col-span-2 md:col-span-2">
              <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold font-mono uppercase ${badgeClasses}">
                ${escapeHtml(item.label)}
              </span>
            </div>
            <div class="col-span-3 md:col-span-2 font-mono text-xs text-stone-brown dark:text-[#9aa4b2] text-right md:text-left truncate">
              ${isFolder ? '--' : formatBytes(item.size)}
            </div>
            <div class="col-span-1 md:col-span-2 flex items-center justify-end md:justify-between text-xs ${isPlayable && isCurrentActive ? 'text-jet-black dark:text-[#c6ac8f] font-semibold' : 'text-stone-brown/70 dark:text-[#758092]'}">
              <span class="hidden md:inline truncate" ${dateTooltip ? `title="${escapeHtml(dateTooltip)}"` : ''}>${escapeHtml(displayStatus)}</span>
              ${actionBtnHtml}
            </div>
          </div>
        `;
      });

      if (this.elements.fileList) {
        this.elements.fileList.innerHTML = html;
      }

      if (window.lucide) window.lucide.createIcons();
      if (MotionAnim) MotionAnim.animateFileList(this.elements.fileList);
      this.initListThumbnailObserver();
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
      if (window.lucide) window.lucide.createIcons();
    },

    updateViewToggleUI() {
      if (!this.elements.viewToggleBtn) return;
      const state = window.Trove.state || {};
      const isTree = state.viewMode === 'tree';
      this.elements.viewToggleBtn.title = isTree 
        ? 'Current: Tree View. Click to switch to Flat View.' 
        : 'Current: Flat View. Click to switch to Tree View.';
      this.elements.viewToggleBtn.innerHTML = `<i data-lucide="${isTree ? 'folder-tree' : 'list'}" class="w-4 h-4"></i>`;
      if (window.lucide) window.lucide.createIcons();
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
      if (window.lucide) window.lucide.createIcons();
    },

    initListThumbnailObserver() {
      const player = window.Trove.player || {};
      if (this.thumbnailObserver) this.thumbnailObserver.disconnect();
      if (!('IntersectionObserver' in window) || !this.elements.fileList) return;

      this.thumbnailObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const slot = entry.target;
            this.thumbnailObserver.unobserve(slot);
            const path = slot.dataset.filePath;
            if (path && !player.thumbnailCache?.has(path)) {
              this.enqueueThumbnailExtraction(path);
            }
          }
        });
      }, { rootMargin: '150px', threshold: 0.05 });

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
      this.processExtractionQueue();
    },

    async processExtractionQueue() {
      const player = window.Trove.player || {};
      const state = window.Trove.state || {};
      if (this.isExtractingQueue || this.extractionQueue.length === 0) return;
      this.isExtractingQueue = true;

      while (this.extractionQueue.length > 0) {
        const path = this.extractionQueue.shift();
        const item = (state.allItems || []).find(i => i.path === path);
        if (!item) continue;

        try {
          const mediaEntry = await player.getMediaBlobAndUrl(item);
          if (mediaEntry && mediaEntry.blob) {
            const thumbUrl = await player.extractThumbnail(mediaEntry.blob, item);
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
          }
        } catch (_) {}
      }

      this.isExtractingQueue = false;
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

      if (this.elements.refreshBtn) {
        this.elements.refreshBtn.addEventListener('click', () => {
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
          this.render();
        });
      }

      if (this.elements.clearSearchBtn) {
        this.elements.clearSearchBtn.addEventListener('click', () => {
          if (this.elements.searchInput) this.elements.searchInput.value = '';
          state.searchQuery = '';
          this.elements.clearSearchBtn.classList.add('hidden');
          this.render();
        });
      }

      // View toggle button
      if (this.elements.viewToggleBtn) {
        this.elements.viewToggleBtn.addEventListener('click', () => {
          state.viewMode = state.viewMode === 'tree' ? 'flat' : 'tree';
          this.updateViewToggleUI();
          if (window.Trove.store) window.Trove.store.saveViewSettings();
          this.render();
        });
      }

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
          this.render();
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
          this.render();
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
          this.render();
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
            this.render();
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
            this.render();
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

          const isDir = row.dataset.isDir === 'true';
          const path = row.dataset.path;

          if (isDir) {
            state.currentDirectory = path;
            if (window.Trove.store) window.Trove.store.saveViewSettings();
            this.render();
          } else {
            const item = (state.allItems || []).find(i => i.path === path);
            if (!item) return;
            if (item.category === 'music' || item.category === 'video') {
              if (player.playTrack) player.playTrack(item);
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

