/**
 * Trove · Hugging Face Dataset Media Vault Explorer & Player
 * Configured dynamically via config.js
 */

(function () {
  'use strict';

  // Read Configuration from config.js
  const CONFIG = window.APP_CONFIG;
  if (!CONFIG) {
    console.error('Trove configuration (config.js) not found!');
    return;
  }

  const { repo, storage, api, extensions } = CONFIG;
  const MUSIC_EXTENSIONS = new Set((extensions.music || []).map(e => e.toLowerCase()));
  const VIDEO_EXTENSIONS = new Set((extensions.video || []).map(e => e.toLowerCase()));
  const TEXT_EXTENSIONS = new Set(['txt', 'json', 'csv', 'md', 'xml', 'yaml', 'yml', 'log', 'tsv', 'pdf']);
  const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'bmp', 'ico']);

  const FILTER_CONFIG = {
    all: { label: 'All', fullLabel: 'All Files', icon: 'layers' },
    music: { label: 'Music', fullLabel: 'Music', icon: 'music' },
    video: { label: 'Video', fullLabel: 'Video', icon: 'video' },
    document: { label: 'Docs', fullLabel: 'Text / Docs', icon: 'file-text' },
    image: { label: 'Images', fullLabel: 'Images', icon: 'image' },
    other: { label: 'Other', fullLabel: 'Other Files', icon: 'file' }
  };

  // Application State
  const state = {
    token: localStorage.getItem(storage.tokenKey) || '',
    allItems: [],
    currentDirectory: '',
    viewMode: 'tree', // 'tree' | 'flat'
    filterType: 'all', // 'all' | 'video' | 'music' | 'document' | 'image' | 'other'
    searchQuery: '',
    isLoading: false,
    error: null
  };

  // DOM Elements
  const elements = {
    appFooter: document.getElementById('app-footer'),
    repoBadge: document.getElementById('repo-badge'),
    repoIdDisplay: document.getElementById('repo-id-display'),
    modalRepoId: document.getElementById('modal-repo-id'),
    authUsername: document.getElementById('auth-username'),
    fileList: document.getElementById('file-list'),
    breadcrumbs: document.getElementById('breadcrumbs'),
    searchInput: document.getElementById('search-input'),
    clearSearchBtn: document.getElementById('clear-search-btn'),
    viewToggleBtn: document.getElementById('view-toggle-btn'),
    viewToggleIcon: document.getElementById('view-toggle-icon'),
    filterDropdownBtn: document.getElementById('filter-dropdown-btn'),
    filterDropdownMenu: document.getElementById('filter-dropdown-menu'),
    filterActiveLabel: document.getElementById('filter-active-label'),
    filterActiveIcon: document.getElementById('filter-active-icon'),
    refreshBtn: document.getElementById('refresh-btn'),
    importBtn: document.getElementById('import-btn'),
    pwaInstallBtn: document.getElementById('pwa-install-btn'),
    activityBtn: document.getElementById('activity-btn'),
    activityBtnIcon: document.getElementById('activity-btn-icon'),
    activityBtnLabel: document.getElementById('activity-btn-label'),
    activityModal: document.getElementById('activity-modal'),
    closeActivityModalBtn: document.getElementById('close-activity-modal-btn'),
    dismissActivityBtn: document.getElementById('dismiss-activity-btn'),
    activityPulseDot: document.getElementById('activity-pulse-dot'),
    activityStatusPill: document.getElementById('activity-status-pill'),
    activityStepInfo: document.getElementById('activity-step-info'),
    activityTimeElapsed: document.getElementById('activity-time-elapsed'),
    activityProgressBar: document.getElementById('activity-progress-bar'),
    activityCounts: document.getElementById('activity-counts'),
    activityGithubLink: document.getElementById('activity-github-link'),
    activityItemsList: document.getElementById('activity-items-list'),
    authSettingsBtn: document.getElementById('auth-settings-btn'),
    authBtnLabel: document.getElementById('auth-btn-label'),
    authModal: document.getElementById('auth-modal'),
    authForm: document.getElementById('auth-form'),
    hfTokenInput: document.getElementById('hf-token-input'),
    toggleTokenVisibility: document.getElementById('toggle-token-visibility'),
    closeModalBtn: document.getElementById('close-modal-btn'),
    authErrorMsg: document.getElementById('auth-error-msg'),
    explorerState: document.getElementById('explorer-state'),
    stateIcon: document.getElementById('state-icon'),
    stateTitle: document.getElementById('state-title'),
    stateDesc: document.getElementById('state-desc'),
    stateActionBtn: document.getElementById('state-action-btn'),
    statTotalFiles: document.getElementById('stat-total-files'),
    statMusicCount: document.getElementById('stat-music-count'),
    statVideoCount: document.getElementById('stat-video-count'),
    statTotalSize: document.getElementById('stat-total-size'),
    footerStatus: document.getElementById('footer-status'),

    // Import Modal Elements
    importModal: document.getElementById('import-modal'),
    closeImportModalBtn: document.getElementById('close-import-modal-btn'),
    cancelImportBtn: document.getElementById('cancel-import-btn'),
    importForm: document.getElementById('import-form'),
    importUrlsInput: document.getElementById('import-urls-input'),
    importFileInput: document.getElementById('import-file-input'),
    importFileDropzone: document.getElementById('import-file-dropzone'),
    importFilenameDisplay: document.getElementById('import-filename-display'),
    importClearFileBtn: document.getElementById('import-clear-file-btn'),
    importProgressBox: document.getElementById('import-progress-box'),
    importStatusText: document.getElementById('import-status-text'),
    importStatusSubtext: document.getElementById('import-status-subtext'),
    importErrorMsg: document.getElementById('import-error-msg'),
    startImportBtn: document.getElementById('start-import-btn'),
    importGhToken: document.getElementById('import-gh-token'),
    importGhRepo: document.getElementById('import-gh-repo'),
    toggleGhConfigBtn: document.getElementById('toggle-gh-config-btn'),
    ghConfigFields: document.getElementById('gh-config-fields'),

    // Media Player Elements
    playerAudio: document.getElementById('player-audio'),
    playerVideo: document.getElementById('player-video'),
    bottomPlayBar: document.getElementById('bottom-play-bar'),
    barExpandTrigger: document.getElementById('bar-expand-trigger'),
    barThumbnail: document.getElementById('bar-thumbnail'),
    barThumbImg: document.getElementById('bar-thumb-img'),
    barTypeIcon: document.getElementById('bar-type-icon'),
    barPlayingIndicator: document.getElementById('bar-playing-indicator'),
    barTrackTitle: document.getElementById('bar-track-title'),
    barTrackExt: document.getElementById('bar-track-ext'),
    barLoadingBadge: document.getElementById('bar-loading-badge'),
    barTimeCurrent: document.getElementById('bar-time-current'),
    barTimeDuration: document.getElementById('bar-time-duration'),
    barProgressSlider: document.getElementById('bar-progress-slider'),
    btnPlayPause: document.getElementById('btn-play-pause'),
    playPauseIcon: document.getElementById('play-pause-icon'),
    btnPrev: document.getElementById('btn-prev'),
    btnNext: document.getElementById('btn-next'),
    btnExpandPlayer: document.getElementById('btn-expand-player'),

    // Expanded Player Elements
    expandedPlayer: document.getElementById('expanded-player'),
    btnMinimizePlayer: document.getElementById('btn-minimize-player'),
    expandedSubtitle: document.getElementById('expanded-subtitle'),
    btnPipToggle: document.getElementById('btn-pip-toggle'),
    btnSpeed: document.getElementById('btn-speed'),
    stageMusic: document.getElementById('stage-music'),
    stageVideo: document.getElementById('stage-video'),
    expandedCoverArt: document.getElementById('expanded-cover-art'),
    expandedCoverImg: document.getElementById('expanded-cover-img'),
    expandedCoverFallback: document.getElementById('expanded-cover-fallback'),
    expandedCoverIcon: document.getElementById('expanded-cover-icon'),
    expandedTrackTitle: document.getElementById('expanded-track-title'),
    expandedTrackMeta: document.getElementById('expanded-track-meta'),
    videoLoadingOverlay: document.getElementById('video-loading-overlay'),
    expandedProgressSlider: document.getElementById('expanded-progress-slider'),
    expandedTimeCurrent: document.getElementById('expanded-time-current'),
    expandedTimeDuration: document.getElementById('expanded-time-duration'),
    btnShuffle: document.getElementById('btn-shuffle'),
    btnExpandedPrev: document.getElementById('btn-expanded-prev'),
    btnExpandedPlay: document.getElementById('btn-expanded-play'),
    expandedPlayIcon: document.getElementById('expanded-play-icon'),
    btnExpandedNext: document.getElementById('btn-expanded-next'),
    btnRepeat: document.getElementById('btn-repeat'),
    activeQueueCounter: document.getElementById('active-queue-counter'),
    btnMute: document.getElementById('btn-mute'),
    volumeIcon: document.getElementById('volume-icon'),
    volumeSlider: document.getElementById('volume-slider')
  };

  // =========================================================================
  // CACHING & PERSISTENCE ENGINE (localStorage + IndexedDB)
  // =========================================================================

  // 1. View Settings (Mode, Filter, Active Folder)
  const VIEW_SETTINGS_KEY = storage.viewSettingsKey || 'trove_view_settings';

  function loadSavedViewSettings() {
    try {
      const raw = localStorage.getItem(VIEW_SETTINGS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.viewMode) state.viewMode = saved.viewMode;
        if (saved.filterType) state.filterType = saved.filterType;
        if (typeof saved.currentDirectory === 'string') state.currentDirectory = saved.currentDirectory;
      }
    } catch (e) {
      console.warn('Could not read view settings:', e);
    }
  }

  function saveViewSettings() {
    try {
      localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify({
        viewMode: state.viewMode,
        filterType: state.filterType,
        currentDirectory: state.currentDirectory
      }));
    } catch (e) {}
  }

  // 2. File System Tree Cache (1-Hour TTL or manual reload)
  const FS_CACHE_KEY = `${storage.fsCacheKey || 'trove_fs_cache'}_${repo.id}`;
  const FS_CACHE_TTL = storage.fsCacheTTL || (60 * 60 * 1000); // 1 hour in ms

  function getCachedFSTree() {
    try {
      const raw = localStorage.getItem(FS_CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data && data.timestamp && (Date.now() - data.timestamp < FS_CACHE_TTL) && Array.isArray(data.items)) {
        return data.items;
      }
    } catch (e) {
      console.warn('Could not read cached FS tree:', e);
    }
    return null;
  }

  function setCachedFSTree(items) {
    try {
      localStorage.setItem(FS_CACHE_KEY, JSON.stringify({
        timestamp: Date.now(),
        items: items
      }));
    } catch (e) {
      console.warn('Could not write cached FS tree:', e);
    }
  }

  // 3. Persistent IndexedDB Storage (Media Blobs & Original-Quality Thumbnails)
  const IDB_NAME = 'TroveMediaStorage';
  const IDB_VERSION = 2;
  const IDB_STORE_MEDIA = 'media_blobs';
  const IDB_STORE_THUMBS = 'thumbnails';
  const MAX_MEDIA_CACHE = storage.maxMediaBlobs || 10;
  const MAX_THUMB_CACHE = storage.maxCachedThumbnails || 50;

  let idbPromise = null;
  function getIDB() {
    if (!idbPromise) {
      idbPromise = new Promise((resolve) => {
        if (!('indexedDB' in window)) {
          resolve(null);
          return;
        }
        try {
          const request = indexedDB.open(IDB_NAME, IDB_VERSION);
          request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE_MEDIA)) {
              const store = db.createObjectStore(IDB_STORE_MEDIA, { keyPath: 'path' });
              store.createIndex('cachedAt', 'cachedAt', { unique: false });
            }
            if (!db.objectStoreNames.contains(IDB_STORE_THUMBS)) {
              const thumbStore = db.createObjectStore(IDB_STORE_THUMBS, { keyPath: 'path' });
              thumbStore.createIndex('cachedAt', 'cachedAt', { unique: false });
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    }
    return idbPromise;
  }

  // Original-Quality Thumbnail Storage in IndexedDB (100% Original Quality, No Downscaling)
  async function saveThumbnailBlobToIDB(path, blob) {
    try {
      const db = await getIDB();
      if (!db) return;
      const tx = db.transaction(IDB_STORE_THUMBS, 'readwrite');
      const store = tx.objectStore(IDB_STORE_THUMBS);
      store.put({ path, blob, cachedAt: Date.now() });

      // Enforce rotation: keep max 50 thumbnails
      const getAllReq = store.index('cachedAt').getAll();
      getAllReq.onsuccess = () => {
        const records = getAllReq.result;
        if (records && records.length > MAX_THUMB_CACHE) {
          records.sort((a, b) => (a.cachedAt || 0) - (b.cachedAt || 0));
          const excess = records.length - MAX_THUMB_CACHE;
          const deleteTx = db.transaction(IDB_STORE_THUMBS, 'readwrite');
          const deleteStore = deleteTx.objectStore(IDB_STORE_THUMBS);
          for (let i = 0; i < excess; i++) {
            deleteStore.delete(records[i].path);
          }
        }
      };
    } catch (e) {
      console.warn('Could not save thumbnail blob to IndexedDB:', e);
    }
  }

  async function getThumbnailBlobFromIDB(path) {
    try {
      const db = await getIDB();
      if (!db) return null;
      return new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE_THUMBS, 'readonly');
        const store = tx.objectStore(IDB_STORE_THUMBS);
        const req = store.get(path);
        req.onsuccess = () => resolve(req.result ? req.result.blob : null);
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  async function loadStoredThumbnails() {
    // Discard any old downscaled localStorage thumbnails
    try {
      localStorage.removeItem('trove_thumbnails_cache');
    } catch (e) {}

    try {
      const db = await getIDB();
      if (!db) return;
      const tx = db.transaction(IDB_STORE_THUMBS, 'readonly');
      const store = tx.objectStore(IDB_STORE_THUMBS);
      const req = store.getAll();
      req.onsuccess = () => {
        const records = req.result;
        if (records && Array.isArray(records)) {
          records.forEach(rec => {
            if (rec && rec.path && rec.blob) {
              const url = URL.createObjectURL(rec.blob);
              player.thumbnailCache.set(rec.path, url);
            }
          });
          refreshVisibleThumbnails();
        }
      };
    } catch (e) {
      console.warn('Could not load stored thumbnails from IndexedDB:', e);
    }
  }

  function refreshVisibleThumbnails() {
    if (!elements.fileList) return;
    const slots = elements.fileList.querySelectorAll('.list-thumb-slot');
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

    if (player.currentTrack && player.thumbnailCache.has(player.currentTrack.path)) {
      player.updateThumbnailUI(player.thumbnailCache.get(player.currentTrack.path), player.currentTrack);
    }
  }

  // 4. Recent Tracks History (Last 10 Played Items with LRU Rotation)
  const RECENT_TRACKS_KEY = storage.recentTracksKey || 'trove_recent_tracks';
  const MAX_RECENT_TRACKS = storage.maxRecentTracks || 10;

  function getRecentTracks() {
    try {
      const raw = localStorage.getItem(RECENT_TRACKS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function addRecentTrack(item, currentTime = 0, duration = 0) {
    if (!item) return;
    try {
      let recent = getRecentTracks();
      recent = recent.filter(t => t.path !== item.path);
      recent.unshift({
        path: item.path,
        name: item.name,
        category: item.category,
        size: item.size,
        ext: item.ext,
        lastPosition: currentTime,
        duration: duration,
        playedAt: Date.now()
      });
      if (recent.length > MAX_RECENT_TRACKS) {
        recent = recent.slice(0, MAX_RECENT_TRACKS);
      }
      localStorage.setItem(RECENT_TRACKS_KEY, JSON.stringify(recent));
    } catch (e) {
      console.warn('Could not save recent track:', e);
    }
  }

  function updateRecentTrackPosition(path, currentTime) {
    try {
      const recent = getRecentTracks();
      const track = recent.find(t => t.path === path);
      if (track) {
        track.lastPosition = currentTime;
        track.playedAt = Date.now();
        localStorage.setItem(RECENT_TRACKS_KEY, JSON.stringify(recent));
      }
    } catch (e) {}
  }

  // 5. Persistent Media Blobs in IndexedDB (Last 10 Media Files - Prevents Memory & RAM Issues)
  async function getMediaFromIDB(path) {
    try {
      const db = await getIDB();
      if (!db) return null;
      return new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE_MEDIA, 'readonly');
        const store = tx.objectStore(IDB_STORE_MEDIA);
        const req = store.get(path);
        req.onsuccess = () => resolve(req.result ? req.result.blob : null);
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  async function saveMediaToIDB(path, blob) {
    try {
      const db = await getIDB();
      if (!db) return;
      const tx = db.transaction(IDB_STORE_MEDIA, 'readwrite');
      const store = tx.objectStore(IDB_STORE_MEDIA);
      store.put({ path, blob, cachedAt: Date.now() });

      // Rotate: enforce max 10 items, deleting the 11th oldest
      const getAllReq = store.index('cachedAt').getAll();
      getAllReq.onsuccess = () => {
        const records = getAllReq.result;
        if (records && records.length > MAX_MEDIA_CACHE) {
          records.sort((a, b) => (a.cachedAt || 0) - (b.cachedAt || 0));
          const excess = records.length - MAX_MEDIA_CACHE;
          const deleteTx = db.transaction(IDB_STORE_MEDIA, 'readwrite');
          const deleteStore = deleteTx.objectStore(IDB_STORE_MEDIA);
          for (let i = 0; i < excess; i++) {
            deleteStore.delete(records[i].path);
          }
        }
      };
    } catch (e) {
      console.warn('IDB write failed:', e);
    }
  }

  // 6. Playback State (Current Track, Scrubber Position, Settings)
  const PLAYBACK_STATE_KEY = storage.playbackStateKey || 'trove_playback_state';

  function savePlaybackState() {
    if (!player.currentTrack) return;
    try {
      const activeEl = player.getActiveElement();
      const currentTime = activeEl ? (activeEl.currentTime || 0) : (player.savedStartTime || 0);
      const duration = activeEl && !isNaN(activeEl.duration) ? activeEl.duration : (player.currentTrack.duration || 0);

      const payload = {
        currentTrack: player.currentTrack,
        currentTime: currentTime,
        duration: duration,
        volume: player.volume ?? 1.0,
        speedIndex: player.speedIndex ?? 1,
        repeat: player.repeat || 'off',
        shuffle: player.shuffle || false,
        isExpanded: player.isExpanded || false,
        updatedAt: Date.now()
      };
      localStorage.setItem(PLAYBACK_STATE_KEY, JSON.stringify(payload));
      updateRecentTrackPosition(player.currentTrack.path, currentTime);
    } catch (e) {}
  }

  function restorePlaybackState() {
    try {
      const raw = localStorage.getItem(PLAYBACK_STATE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || !saved.currentTrack) return;

      const track = saved.currentTrack;
      player.currentTrack = track;
      player.volume = typeof saved.volume === 'number' ? saved.volume : 1.0;
      player.speedIndex = typeof saved.speedIndex === 'number' ? saved.speedIndex : 1;
      player.repeat = saved.repeat || 'off';
      player.shuffle = saved.shuffle || false;
      player.savedStartTime = saved.currentTime || 0;

      // Update volume and speed UI
      if (elements.btnSpeed) elements.btnSpeed.innerText = `${player.playbackRates[player.speedIndex]}x`;
      if (elements.volumeSlider) elements.volumeSlider.value = player.volume;
      if (elements.playerAudio) elements.playerAudio.volume = player.volume;
      if (elements.playerVideo) elements.playerVideo.volume = player.volume;

      // Shuffle UI
      if (player.shuffle && elements.btnShuffle) {
        elements.btnShuffle.classList.add('text-jet-black', 'font-bold');
        elements.btnShuffle.classList.remove('text-stone-brown/50');
      }
      // Repeat UI
      if (elements.btnRepeat) {
        if (player.repeat === 'all') {
          elements.btnRepeat.classList.add('text-jet-black', 'font-bold');
          elements.btnRepeat.classList.remove('text-stone-brown/50');
        } else if (player.repeat === 'one') {
          elements.btnRepeat.classList.add('text-jet-black', 'font-bold');
          elements.btnRepeat.classList.remove('text-stone-brown/50');
          elements.btnRepeat.innerHTML = '<i data-lucide="repeat-1" class="w-5 h-5"></i>';
        }
      }

      // Track titles & Metadata
      if (elements.barTrackTitle) elements.barTrackTitle.innerText = track.name;
      if (elements.barTrackExt) elements.barTrackExt.innerText = track.label || 'MEDIA';
      if (elements.expandedTrackTitle) elements.expandedTrackTitle.innerText = track.name;
      if (elements.expandedTrackMeta) elements.expandedTrackMeta.innerText = `${track.label || 'MEDIA'} • ${formatBytes(track.size)} • ${track.parentDir || 'Root'}`;
      if (elements.expandedSubtitle) elements.expandedSubtitle.innerText = `${repo.id} / ${track.parentDir || 'Vault'}`;

      // Timestamps & Scrubber
      const cur = saved.currentTime || 0;
      const dur = saved.duration || 0;
      if (elements.barTimeCurrent) elements.barTimeCurrent.innerText = formatTime(cur);
      if (elements.expandedTimeCurrent) elements.expandedTimeCurrent.innerText = formatTime(cur);
      if (dur > 0) {
        if (elements.barTimeDuration) elements.barTimeDuration.innerText = formatTime(dur);
        if (elements.expandedTimeDuration) elements.expandedTimeDuration.innerText = formatTime(dur);
        const pct = (cur / dur) * 100;
        if (elements.barProgressSlider) elements.barProgressSlider.value = pct;
        if (elements.expandedProgressSlider) elements.expandedProgressSlider.value = pct;
      }

      // Thumbnail
      const cachedThumb = player.thumbnailCache.get(track.path) || null;
      player.updateThumbnailUI(cachedThumb, track);

      // Show the floating play bar in paused/ready state
      player.showBottomBar();
      player.updatePlayStateUI();

      if (window.lucide) window.lucide.createIcons();
    } catch (e) {
      console.warn('Error restoring playback state:', e);
    }
  }

  // Utility: Classify File Type by Extension
  function getFileInfo(path, isDir = false) {
    if (isDir) {
      return { category: 'folder', label: 'Folder', ext: '', icon: 'folder' };
    }

    const segments = path.split('/');
    const filename = segments[segments.length - 1];
    const dotIndex = filename.lastIndexOf('.');

    let ext = '';
    if (dotIndex > 0 && dotIndex < filename.length - 1) {
      ext = filename.slice(dotIndex + 1).toLowerCase();
    }

    if (MUSIC_EXTENSIONS.has(ext)) {
      return { category: 'music', label: ext.toUpperCase(), ext, icon: 'music' };
    }
    if (VIDEO_EXTENSIONS.has(ext)) {
      return { category: 'video', label: ext.toUpperCase(), ext, icon: 'video' };
    }
    if (TEXT_EXTENSIONS.has(ext)) {
      return { category: 'document', label: ext.toUpperCase(), ext, icon: 'file-text' };
    }
    if (IMAGE_EXTENSIONS.has(ext)) {
      return { category: 'image', label: ext.toUpperCase(), ext, icon: 'image' };
    }

    return { category: 'other', label: ext ? ext.toUpperCase() : 'FILE', ext, icon: 'file' };
  }

  // Utility: Format File Size
  function formatBytes(bytes) {
    if (!bytes || isNaN(bytes) || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // Utility: Format Seconds into mm:ss
  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  // Fetch Bucket or Dataset File System from Hugging Face API
  async function fetchHFTree(token) {
    const isBucket = repo.isBucket !== false;
    
    // For Storage Buckets: /api/buckets/{namespace}/{bucket}/tree?recursive=true
    // For Datasets: /api/datasets/{namespace}/{repo}/tree/{branch}?recursive=true
    const candidateUrls = isBucket
      ? [
          `${api.bucketsBase}/${repo.id}/tree?recursive=true`,
          `${api.bucketsBase}/${repo.id}/tree/?recursive=true`,
          `${api.bucketsBase}/${repo.id}/tree`,
          `${api.bucketsBase}/${repo.id}`
        ]
      : [
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
            headers: {
              'Authorization': `Bearer ${token}`
            }
          });

          if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
              throw new Error('AUTH_ERROR');
            }
            if (response.status === 404) {
              throw new Error('NOT_FOUND');
            }
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

          // Check pagination header
          const linkHeader = response.headers.get('Link');
          url = null;
          if (linkHeader) {
            const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            if (match) {
              url = match[1];
            }
          }
        }

        if (results.length > 0 || baseUrl === candidateUrls[0]) {
          return results;
        }
      } catch (err) {
        lastError = err;
        if (err.message === 'AUTH_ERROR') throw err;
        // Try next candidate URL
      }
    }

    if (lastError) throw lastError;
    return [];
  }

  // Fallback: Fetch Repo / Bucket Metadata if tree endpoint fails
  async function fetchHFSiblingsFallback(token) {
    const isBucket = repo.isBucket !== false;
    const url = isBucket
      ? `${api.bucketsBase}/${repo.id}`
      : `${api.datasetsBase}/${repo.id}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
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
  }

  // Load and Parse Bucket (Uses 1-hour cache unless forceRefresh is true)
  async function loadRepository(forceRefresh = false) {
    if (!state.token) {
      showAuthModal('Please enter your Hugging Face Token to view this private dataset.');
      return;
    }

    // Check 1-hour cache if not an explicit reload
    if (!forceRefresh) {
      const cached = getCachedFSTree();
      if (cached && Array.isArray(cached) && cached.length > 0) {
        state.allItems = normalizeFileEntries(cached);
        updateStats();
        const fileCount = state.allItems.filter(i => !i.isDir).length;
        updateFooterStatus(`Loaded ${fileCount} files (cached)`);
        if (player.currentTrack) {
          player.updateQueue(player.currentTrack);
        }
        setLoading(false);
        render();
        return;
      }
    }

    setLoading(true);
    state.error = null;
    render(); // Display loader immediately

    try {
      let rawItems = [];
      try {
        rawItems = await fetchHFTree(state.token);
      } catch (treeErr) {
        if (treeErr.message === 'AUTH_ERROR') throw treeErr;
        console.warn('Tree API endpoint failed, trying repository fallback...', treeErr);
        rawItems = await fetchHFSiblingsFallback(state.token);
      }

      state.allItems = normalizeFileEntries(rawItems);
      // Persist to 1-hour localStorage cache
      setCachedFSTree(rawItems);

      updateStats();
      const fileCount = state.allItems.filter(i => !i.isDir).length;
      updateFooterStatus(`Loaded ${fileCount} files${forceRefresh ? ' (refreshed)' : ''}`);
      if (player.currentTrack) {
        player.updateQueue(player.currentTrack);
      }
    } catch (err) {
      console.error('Failed to load dataset:', err);
      if (err.message === 'AUTH_ERROR') {
        state.error = `Unauthorized (401/403): Invalid token or insufficient permissions for ${repo.id}.`;
        showAuthModal(state.error);
      } else if (err.message === 'NOT_FOUND' || err.message.includes('404')) {
        state.error = `Bucket not found (404). For private buckets, Hugging Face returns 404 if your token lacks access to ${repo.id}.`;
        showAuthModal(state.error);
      } else {
        state.error = err.message || 'Failed to fetch repository files.';
      }
      updateFooterStatus('Error loading repository');
    } finally {
      setLoading(false);
      render(); // Render files now that loading is false
    }
  }

  // Normalize entries & build virtual folder structure
  function normalizeFileEntries(rawItems) {
    const itemsMap = new Map();

    rawItems.forEach(item => {
      // Extract path / key
      const rawPath = item.path || item.key || item.Key || item.name || '';
      if (!rawPath || rawPath.startsWith('.git/')) return;

      // Clean leading/trailing slashes
      const cleanPath = rawPath.replace(/^\/+|\/+$/g, '');
      if (!cleanPath) return;

      const isDir = item.type === 'directory' || item.type === 'folder' || rawPath.endsWith('/');
      const size = item.size ?? item.Size ?? (item.lfs ? item.lfs.size : 0) ?? 0;
      const fileInfo = getFileInfo(cleanPath, isDir);

      const pathParts = cleanPath.split('/');
      const name = pathParts[pathParts.length - 1];
      const parentDir = pathParts.slice(0, -1).join('/');

      itemsMap.set(cleanPath, {
        path: cleanPath,
        name: name,
        parentDir: parentDir,
        isDir: isDir,
        size: size,
        category: fileInfo.category,
        label: fileInfo.label,
        ext: fileInfo.ext,
        icon: fileInfo.icon
      });

      // Synthesize missing intermediate directory nodes
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
  }

  // Update Overview Stats
  function updateStats() {
    const filesOnly = state.allItems.filter(item => !item.isDir && item.name !== '.gitattributes' && item.name !== '.trove_status.json');
    const musicFiles = filesOnly.filter(item => item.category === 'music');
    const videoFiles = filesOnly.filter(item => item.category === 'video');
    const totalBytes = filesOnly.reduce((acc, item) => acc + (item.size || 0), 0);

    if (elements.statTotalFiles) elements.statTotalFiles.innerText = filesOnly.length.toLocaleString();
    if (elements.statMusicCount) elements.statMusicCount.innerText = musicFiles.length.toLocaleString();
    if (elements.statVideoCount) elements.statVideoCount.innerText = videoFiles.length.toLocaleString();
    if (elements.statTotalSize) elements.statTotalSize.innerText = formatBytes(totalBytes);
  }

  // Filter Items based on View, Folder, Category, and Search
  function getDisplayItems() {
    let items = state.allItems;

    // Search query
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      items = items.filter(i => !i.isDir && i.name !== '.gitattributes' && i.name !== '.trove_status.json' && i.path.toLowerCase().includes(q));

      if (state.filterType !== 'all') {
        items = items.filter(i => i.category === state.filterType || (i.ext && i.ext.toLowerCase() === state.filterType));
      }

      return items.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Flat mode
    if (state.viewMode === 'flat') {
      items = items.filter(i => !i.isDir && i.name !== '.gitattributes' && i.name !== '.trove_status.json');

      if (state.filterType !== 'all') {
        items = items.filter(i => i.category === state.filterType || (i.ext && i.ext.toLowerCase() === state.filterType));
      }

      return items.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Tree mode
    const current = state.currentDirectory;
    const directChildren = items.filter(i => i.parentDir === current && i.name !== '.gitattributes' && i.name !== '.trove_status.json');

    let filteredChildren = directChildren;
    if (state.filterType !== 'all') {
      filteredChildren = directChildren.filter(i => i.isDir || i.category === state.filterType || (i.ext && i.ext.toLowerCase() === state.filterType));
    }

    return filteredChildren.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  // Render UI
  function render() {
    if (state.isLoading) {
      showState('loader-2', 'Loading Repository', 'Connecting to Hugging Face dataset tree...', false, '', null, true);
      elements.fileList.innerHTML = '';
      return;
    }

    if (state.error) {
      showState(
        'alert-circle',
        'Connection Error',
        state.error,
        true,
        'Enter Token / Retry',
        () => showAuthModal()
      );
      elements.fileList.innerHTML = '';
      return;
    }

    renderBreadcrumbs();

    const items = getDisplayItems();

    if (items.length === 0) {
      elements.fileList.innerHTML = '';
      const filterLabel = FILTER_CONFIG[state.filterType]?.fullLabel || state.filterType;
      const message = state.searchQuery
        ? `No files matching "${state.searchQuery}"`
        : state.filterType !== 'all'
        ? `No ${filterLabel} files found here.`
        : 'This folder is empty.';
      showState('inbox', 'No Files Found', message, false);
      return;
    }

    hideState();

    let html = '';

    // Show ".." parent folder row if inside a subfolder in tree view
    if (state.viewMode === 'tree' && state.currentDirectory !== '' && !state.searchQuery) {
      html += `
        <div class="grid grid-cols-12 items-center px-4 py-2.5 hover:bg-almond-cream/20 cursor-pointer transition text-sm" data-action="go-parent">
          <div class="col-span-7 md:col-span-6 flex items-center gap-3 min-w-0">
            <div class="w-8 h-8 rounded-lg bg-almond-cream/60 text-stone-brown flex items-center justify-center shrink-0">
              <i data-lucide="corner-left-up" class="w-4 h-4"></i>
            </div>
            <div class="flex flex-col min-w-0">
              <span class="font-semibold text-black truncate">..</span>
              <span class="font-mono text-[11px] text-stone-brown/60 truncate">Parent Directory</span>
            </div>
          </div>
          <div class="col-span-2 md:col-span-2">
            <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold font-mono uppercase bg-almond-cream/60 text-stone-brown">UP</span>
          </div>
          <div class="col-span-3 md:col-span-2 font-mono text-xs text-stone-brown/60 text-right md:text-left">--</div>
          <div class="hidden md:block col-span-2 text-xs text-stone-brown/60">Directory</div>
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

      // Category badge styling
      let badgeClasses = 'bg-gray-100 text-stone-brown';
      let iconColor = 'bg-almond-cream/40 text-stone-brown';

      if (item.category === 'music') {
        badgeClasses = 'bg-almond-cream text-stone-brown';
        iconColor = isCurrentActive ? 'bg-jet-black text-almond-cream' : 'bg-almond-cream text-stone-brown';
      } else if (item.category === 'video') {
        badgeClasses = 'bg-jet-black text-almond-cream';
        iconColor = 'bg-jet-black text-almond-cream';
      } else if (item.category === 'folder') {
        badgeClasses = 'bg-almond-cream/60 text-stone-brown';
        iconColor = 'bg-almond-cream/60 text-stone-brown';
      } else if (item.category === 'document') {
        badgeClasses = 'bg-khaki-beige/35 text-jet-black font-semibold';
        iconColor = 'bg-khaki-beige/25 text-stone-brown';
      } else if (item.category === 'image') {
        badgeClasses = 'bg-amber-100 text-amber-900 font-semibold';
        iconColor = 'bg-amber-50 text-amber-800';
      }

      const activeRowClass = isCurrentActive 
        ? 'bg-almond-cream/30 border-l-4 border-l-jet-black font-medium' 
        : 'hover:bg-almond-cream/15';

      let thumbSlotHtml = '';
      if (isPlayable) {
        const cachedThumb = player.thumbnailCache.get(item.path);
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

      html += `
        <div class="file-row grid grid-cols-12 items-center px-3 py-2.5 sm:px-4 sm:py-3 transition text-sm cursor-pointer ${activeRowClass}" data-path="${escapeHtml(item.path)}" data-is-dir="${isFolder}" title="${escapeHtml(item.name)} (${isFolder ? 'Folder' : (isPlayable ? 'Click to play' : 'Click to open in new tab')})">
          <div class="col-span-7 md:col-span-6 flex items-center gap-2.5 sm:gap-3 min-w-0">
            ${thumbSlotHtml}
            <div class="flex flex-col min-w-0">
              <span class="font-semibold text-black truncate ${isCurrentActive ? 'text-jet-black' : ''}">${escapeHtml(item.name)}</span>
              <span class="font-mono text-[11px] text-stone-brown/60 truncate">${escapeHtml(pathSub)}</span>
            </div>
          </div>
          <div class="col-span-2 md:col-span-2">
            <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold font-mono uppercase ${badgeClasses}">
              ${escapeHtml(item.label)}
            </span>
          </div>
          <div class="col-span-3 md:col-span-2 font-mono text-xs text-stone-brown text-right md:text-left">
            ${isFolder ? '--' : formatBytes(item.size)}
          </div>
          <div class="hidden md:block col-span-2 text-xs ${isPlayable && isCurrentActive ? 'text-jet-black font-semibold' : 'text-stone-brown/70'}">
            ${statusText}
          </div>
        </div>
      `;
    });

    elements.fileList.innerHTML = html;

    // Refresh Lucide Icons in newly rendered HTML
    if (window.lucide) {
      window.lucide.createIcons();
    }

    // Trigger lazy extraction for visible file thumbnails
    initListThumbnailObserver();
  }

  // Intelligent Lazy Thumbnail Observer & Extractor
  let thumbnailObserver = null;
  const extractionQueue = [];
  let isExtractingQueue = false;

  function initListThumbnailObserver() {
    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
    }

    if (!('IntersectionObserver' in window)) {
      return;
    }

    thumbnailObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const slot = entry.target;
          thumbnailObserver.unobserve(slot);
          const path = slot.dataset.filePath;
          if (path && !player.thumbnailCache.has(path)) {
            enqueueThumbnailExtraction(path);
          }
        }
      });
    }, {
      root: null,
      rootMargin: '150px',
      threshold: 0.05
    });

    const slots = elements.fileList.querySelectorAll('.list-thumb-slot');
    slots.forEach(slot => {
      const path = slot.dataset.filePath;
      if (player.thumbnailCache.has(path)) {
        const img = slot.querySelector('.list-thumb-img');
        const iconWrapper = slot.querySelector('.list-thumb-icon-wrapper');
        if (img && iconWrapper) {
          img.src = player.thumbnailCache.get(path);
          img.classList.remove('hidden');
          iconWrapper.classList.add('hidden');
        }
      } else {
        thumbnailObserver.observe(slot);
      }
    });
  }

  function enqueueThumbnailExtraction(path) {
    if (extractionQueue.includes(path) || player.thumbnailCache.has(path)) return;
    extractionQueue.push(path);
    processExtractionQueue();
  }

  async function processExtractionQueue() {
    if (isExtractingQueue || extractionQueue.length === 0) return;
    isExtractingQueue = true;

    while (extractionQueue.length > 0) {
      const path = extractionQueue.shift();
      const item = state.allItems.find(i => i.path === path);
      if (!item) continue;

      try {
        const mediaEntry = await player.getMediaBlobAndUrl(item);
        if (mediaEntry && mediaEntry.blob) {
          const thumbUrl = await player.extractThumbnail(mediaEntry.blob, item);
          if (thumbUrl) {
            const slots = elements.fileList.querySelectorAll('.list-thumb-slot');
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
      } catch (err) {
        // Silently continue
      }
    }

    isExtractingQueue = false;
  }

  // Render Breadcrumbs
  function renderBreadcrumbs() {
    if (state.viewMode === 'flat' || state.searchQuery) {
      elements.breadcrumbs.innerHTML = `
        <span class="font-semibold text-jet-black">
          ${state.searchQuery ? `Search Results: "${escapeHtml(state.searchQuery)}"` : 'All Files (Flat View)'}
        </span>
      `;
      return;
    }

    const parts = state.currentDirectory ? state.currentDirectory.split('/') : [];

    let html = `
      <div class="breadcrumb-item inline-flex items-center gap-1.5 px-2 py-1 rounded hover:bg-almond-cream/60 cursor-pointer transition ${parts.length === 0 ? 'font-bold text-jet-black' : 'text-stone-brown'}" data-dir="">
        <i data-lucide="folder" class="w-3.5 h-3.5"></i>
        <span>Root</span>
      </div>
    `;

    let accumulatedPath = '';
    parts.forEach((part, index) => {
      accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;
      const isLast = index === parts.length - 1;
      html += `
        <span class="text-khaki-beige select-none">/</span>
        <div class="breadcrumb-item px-2 py-1 rounded hover:bg-almond-cream/60 cursor-pointer transition ${isLast ? 'font-bold text-jet-black' : 'text-stone-brown'}" data-dir="${escapeHtml(accumulatedPath)}">
          <span>${escapeHtml(part)}</span>
        </div>
      `;
    });

    elements.breadcrumbs.innerHTML = html;

    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  // State Banner Helpers
  function showState(iconName, title, desc, showBtn = false, btnLabel = 'Retry', onBtnClick = null, spin = false) {
    elements.explorerState.style.display = 'flex';
    elements.stateIcon.innerHTML = `<i data-lucide="${iconName}" class="w-10 h-10 ${spin ? 'animate-spin' : ''}"></i>`;
    elements.stateTitle.innerText = title;
    elements.stateDesc.innerText = desc;

    if (showBtn) {
      elements.stateActionBtn.classList.remove('hidden');
      elements.stateActionBtn.innerText = btnLabel;
      elements.stateActionBtn.onclick = onBtnClick;
    } else {
      elements.stateActionBtn.classList.add('hidden');
      elements.stateActionBtn.onclick = null;
    }

    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  function hideState() {
    elements.explorerState.style.display = 'none';
  }

  function setLoading(loading) {
    state.isLoading = loading;
    elements.refreshBtn.disabled = loading;
    if (loading) {
      updateFooterStatus('Connecting to Hugging Face...');
    }
  }

  function updateFooterStatus(text) {
    elements.footerStatus.innerText = text;
  }

  // Authentication Modal Logic
  function showAuthModal(errorText = '') {
    elements.authModal.style.display = 'flex';
    elements.hfTokenInput.value = state.token || '';
    if (errorText) {
      elements.authErrorMsg.innerText = errorText;
      elements.authErrorMsg.classList.remove('hidden');
    } else {
      elements.authErrorMsg.classList.add('hidden');
    }
    setTimeout(() => elements.hfTokenInput.focus(), 50);

    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  function hideAuthModal() {
    elements.authModal.style.display = 'none';
    elements.authErrorMsg.classList.add('hidden');
  }

  // ==========================================
  // YOUTUBE IMPORT & GITHUB ACTIONS RUNNER
  // ==========================================
  // ==========================================
  // Live Ingestion Activity & Workflow Monitor (GitHub Actions API)
  // ==========================================
  let activeIngestionPollTimer = null;
  let lastKnownRunId = null;
  let lastKnownStatus = null;

  function showActivityModal() {
    if (elements.activityModal) {
      elements.activityModal.style.display = 'flex';
      if (window.lucide) window.lucide.createIcons();
      // Instantly poll GitHub API with fresh no-cache request on modal open!
      pollActiveIngestion(true);
    }
  }

  function hideActivityModal() {
    if (elements.activityModal) {
      elements.activityModal.style.display = 'none';
      // Stop polling when modal is closed
      if (activeIngestionPollTimer) {
        clearTimeout(activeIngestionPollTimer);
        activeIngestionPollTimer = null;
      }
    }
  }

  function setActivityButtonIdle() {
    if (!elements.activityBtn) return;
    elements.activityBtn.className = 'w-8 h-8 inline-flex items-center justify-center rounded-lg bg-white border border-khaki-beige text-jet-black hover:bg-almond-cream/40 transition shadow-sm select-none';
    elements.activityBtn.title = 'Ingestion Activity';
    if (elements.activityBtnIcon) {
      elements.activityBtnIcon.setAttribute('data-lucide', 'activity');
      elements.activityBtnIcon.className = 'w-4 h-4 text-stone-brown';
    }
    if (elements.activityBtnLabel) {
      elements.activityBtnLabel.className = 'sr-only';
      elements.activityBtnLabel.innerText = 'Activity';
    }
    if (window.lucide) window.lucide.createIcons();
  }

  function showActivityButton(label = 'Ingesting', isSpinning = true, variant = 'amber') {
    if (!elements.activityBtn) return;

    if (variant === 'green') {
      elements.activityBtn.className = 'h-8 px-2 sm:px-2.5 inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-900 hover:bg-emerald-500/25 transition shadow-sm select-none';
      elements.activityBtn.title = 'Ingestion Completed - Click to view details';
      if (elements.activityBtnIcon) {
        elements.activityBtnIcon.setAttribute('data-lucide', 'check-circle-2');
        elements.activityBtnIcon.className = 'w-3.5 h-3.5 text-emerald-600 shrink-0';
      }
      if (elements.activityBtnLabel) {
        elements.activityBtnLabel.className = 'text-xs font-semibold font-mono hidden xs:inline';
        elements.activityBtnLabel.innerText = label;
      }
    } else if (variant === 'red') {
      elements.activityBtn.className = 'h-8 px-2 sm:px-2.5 inline-flex items-center gap-1.5 rounded-lg bg-red-500/15 border border-red-500/30 text-red-900 hover:bg-red-500/25 transition shadow-sm select-none';
      elements.activityBtn.title = 'Ingestion Failed - Click to view details';
      if (elements.activityBtnIcon) {
        elements.activityBtnIcon.setAttribute('data-lucide', 'alert-circle');
        elements.activityBtnIcon.className = 'w-3.5 h-3.5 text-red-600 shrink-0';
      }
      if (elements.activityBtnLabel) {
        elements.activityBtnLabel.className = 'text-xs font-semibold font-mono hidden xs:inline';
        elements.activityBtnLabel.innerText = label;
      }
    } else {
      // Active Ingesting (Amber)
      elements.activityBtn.className = 'h-8 px-2 sm:px-2.5 inline-flex items-center gap-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-900 hover:bg-amber-500/25 transition shadow-sm select-none';
      elements.activityBtn.title = 'Ingestion in progress - Click to view details';
      if (elements.activityBtnIcon) {
        elements.activityBtnIcon.setAttribute('data-lucide', 'loader-2');
        elements.activityBtnIcon.className = 'w-3.5 h-3.5 animate-spin text-amber-600 shrink-0';
      }
      if (elements.activityBtnLabel) {
        elements.activityBtnLabel.className = 'text-xs font-semibold font-mono hidden xs:inline';
        elements.activityBtnLabel.innerText = label;
      }
    }

    if (window.lucide) window.lucide.createIcons();
  }

  function hideActivityButton() {
    setActivityButtonIdle();
  }

  function formatDuration(seconds) {
    if (!seconds || isNaN(seconds) || seconds < 0) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  function renderActivityModal(run, steps = []) {
    if (!elements.activityModal) return;

    if (!run) {
      if (elements.activityStatusPill) {
        elements.activityStatusPill.innerText = 'Idle';
        elements.activityStatusPill.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-gray-100 text-stone-brown';
        if (elements.activityPulseDot) elements.activityPulseDot.className = 'w-2.5 h-2.5 rounded-full bg-stone-brown/40';
      }
      if (elements.activityStepInfo) elements.activityStepInfo.innerText = 'No ingestion runs recorded yet.';
      if (elements.activityTimeElapsed) elements.activityTimeElapsed.innerText = '00:00';
      if (elements.activityProgressBar) {
        elements.activityProgressBar.style.width = '0%';
        elements.activityProgressBar.className = 'bg-jet-black h-full rounded-full transition-all duration-300';
      }
      if (elements.activityCounts) elements.activityCounts.innerText = 'Ready to import';
      if (elements.activityItemsList) {
        elements.activityItemsList.innerHTML = `
          <div class="p-4 text-center text-xs text-stone-brown bg-almond-cream/15 rounded-xl border border-dashed border-almond-cream flex flex-col items-center gap-2">
            <i data-lucide="info" class="w-4 h-4 text-stone-brown/60"></i>
            <span>No active downloads. Click the Import button (download icon) in the header to import songs from YouTube.</span>
          </div>
        `;
      }
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    // Direct link to terminal
    if (elements.activityGithubLink && run.html_url) {
      elements.activityGithubLink.href = run.html_url;
    }

    const isRunning = run.status === 'in_progress' || run.status === 'queued';
    const isSuccess = run.status === 'completed' && run.conclusion === 'success';

    // Calculate duration / elapsed time
    const startTime = new Date(run.run_started_at || run.created_at).getTime();
    const endTime = isRunning ? Date.now() : new Date(run.updated_at || run.completed_at || Date.now()).getTime();
    const elapsedSec = Math.max(0, Math.floor((endTime - startTime) / 1000));

    if (elements.activityTimeElapsed) {
      elements.activityTimeElapsed.innerText = formatDuration(elapsedSec);
    }

    // Filter relevant steps (exclude Set up job / Complete job boilerplate)
    const visibleSteps = steps.filter(s => s.name !== 'Set up job' && s.name !== 'Complete job');
    const totalSteps = Math.max(1, visibleSteps.length);
    const completedStepsCount = visibleSteps.filter(s => s.status === 'completed' && s.conclusion === 'success').length;
    const activeStep = visibleSteps.find(s => s.status === 'in_progress');

    // Overview Card Progress & Step Info
    if (isRunning) {
      const pct = Math.min(95, Math.round((completedStepsCount / totalSteps) * 100));
      if (elements.activityProgressBar) {
        elements.activityProgressBar.style.width = `${Math.max(10, pct)}%`;
        elements.activityProgressBar.className = 'bg-amber-500 h-full rounded-full transition-all duration-300';
      }
      if (elements.activityStatusPill) {
        elements.activityStatusPill.innerText = run.status === 'queued' ? 'Queued' : 'In Progress';
        elements.activityStatusPill.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800';
        if (elements.activityPulseDot) elements.activityPulseDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse';
      }
      if (elements.activityStepInfo) {
        elements.activityStepInfo.innerText = activeStep ? `Step: ${activeStep.name}` : (run.status === 'queued' ? 'Runner queued in GitHub Actions...' : 'Running workflow...');
      }
      if (elements.activityCounts) {
        elements.activityCounts.innerText = `Step ${completedStepsCount + (activeStep ? 1 : 0)} of ${totalSteps}`;
      }
    } else if (isSuccess) {
      if (elements.activityProgressBar) {
        elements.activityProgressBar.style.width = '100%';
        elements.activityProgressBar.className = 'bg-emerald-500 h-full rounded-full transition-all duration-300';
      }
      if (elements.activityStatusPill) {
        elements.activityStatusPill.innerText = 'Completed';
        elements.activityStatusPill.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-800';
        if (elements.activityPulseDot) elements.activityPulseDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500';
      }
      if (elements.activityStepInfo) {
        elements.activityStepInfo.innerText = `Finished successfully in ${formatDuration(elapsedSec)}`;
      }
      if (elements.activityCounts) {
        elements.activityCounts.innerText = `All ${totalSteps} steps completed`;
      }
    } else {
      // Failed / Cancelled
      if (elements.activityProgressBar) {
        elements.activityProgressBar.style.width = '100%';
        elements.activityProgressBar.className = 'bg-red-500 h-full rounded-full transition-all duration-300';
      }
      if (elements.activityStatusPill) {
        elements.activityStatusPill.innerText = run.conclusion ? run.conclusion.toUpperCase() : 'FAILED';
        elements.activityStatusPill.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-red-100 text-red-800';
        if (elements.activityPulseDot) elements.activityPulseDot.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
      }
      if (elements.activityStepInfo) {
        elements.activityStepInfo.innerText = `Run ended with: ${run.conclusion || 'failure'}`;
      }
      if (elements.activityCounts) {
        elements.activityCounts.innerText = 'Check terminal logs for errors';
      }
    }

    // Render Steps List
    if (elements.activityItemsList) {
      if (visibleSteps.length === 0) {
        elements.activityItemsList.innerHTML = `
          <div class="p-3 text-center text-xs text-stone-brown bg-almond-cream/15 rounded-xl border border-dashed border-almond-cream">
            ${isRunning ? 'Connecting to runner...' : 'Workflow completed.'}
          </div>
        `;
      } else {
        let listHtml = '';
        visibleSteps.forEach((st, idx) => {
          let badge = '';
          let rowBg = 'bg-almond-cream/15 border-almond-cream/60';

          if (st.status === 'completed' && st.conclusion === 'success') {
            badge = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-emerald-100 text-emerald-800 shrink-0"><i data-lucide="check" class="w-3 h-3"></i>Done</span>';
            rowBg = 'bg-emerald-50/50 border-emerald-200/60';
          } else if (st.status === 'in_progress') {
            badge = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-amber-100 text-amber-800 shrink-0"><i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i>In Progress</span>';
            rowBg = 'bg-amber-50/80 border-amber-300';
          } else if (st.conclusion === 'failure') {
            badge = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-red-100 text-red-800 shrink-0"><i data-lucide="x" class="w-3 h-3"></i>Failed</span>';
            rowBg = 'bg-red-50/60 border-red-200';
          } else {
            badge = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-gray-100 text-stone-brown shrink-0"><i data-lucide="clock" class="w-3 h-3"></i>Queued</span>';
          }

          listHtml += `
            <div class="p-2.5 rounded-xl border text-xs flex items-center justify-between gap-2.5 transition ${rowBg}">
              <div class="flex items-center gap-2 min-w-0 flex-1">
                <span class="font-mono text-[10px] text-stone-brown/60 shrink-0">#${idx + 1}</span>
                <span class="font-semibold text-black truncate" title="${escapeHtml(st.name)}">${escapeHtml(st.name)}</span>
              </div>
              ${badge}
            </div>
          `;
        });
        elements.activityItemsList.innerHTML = listHtml;
      }
    }

    if (window.lucide) window.lucide.createIcons();
  }

  async function pollActiveIngestion(isManual = false) {
    // Only poll when the user is actively viewing the activity modal!
    if (!elements.activityModal || elements.activityModal.style.display !== 'flex') {
      if (activeIngestionPollTimer) {
        clearTimeout(activeIngestionPollTimer);
        activeIngestionPollTimer = null;
      }
      return;
    }

    const ghToken = localStorage.getItem(storage.ghTokenKey) || '';
    const defaultRepo = (CONFIG.github?.owner && CONFIG.github?.repo) ? `${CONFIG.github.owner}/${CONFIG.github.repo}` : 'mnswamedia/trove';
    const rawRepo = localStorage.getItem(storage.ghRepoKey) || defaultRepo;
    const [owner, repoName] = rawRepo.split('/').map(s => s.trim());
    const workflowFile = CONFIG.github?.workflowFile || 'ingest.yml';

    let nextDelay = 5000;

    try {
      // Force non-cached request directly to GitHub Actions API
      const runsUrl = `https://api.github.com/repos/${owner}/${repoName}/actions/workflows/${workflowFile}/runs?per_page=5&_t=${Date.now()}`;
      const headers = {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      };
      if (ghToken) headers['Authorization'] = `Bearer ${ghToken}`;

      const res = await fetch(runsUrl, { headers, cache: 'no-store' });

      if (res.ok) {
        const data = await res.json();
        const runs = data.workflow_runs || [];

        if (runs.length > 0) {
          const latestRun = runs[0];
          const isRunning = latestRun.status === 'in_progress' || latestRun.status === 'queued';

          // Fetch job steps for latest run with no-store cache
          let steps = [];
          try {
            const jobsUrl = `https://api.github.com/repos/${owner}/${repoName}/actions/runs/${latestRun.id}/jobs?_t=${Date.now()}`;
            const jobsRes = await fetch(jobsUrl, { headers, cache: 'no-store' });
            if (jobsRes.ok) {
              const jobsData = await jobsRes.json();
              const job = (jobsData.jobs || [])[0];
              if (job && Array.isArray(job.steps)) {
                steps = job.steps;
              }
            }
          } catch (_) {}

          // Render modal UI
          renderActivityModal(latestRun, steps);

          if (isRunning) {
            nextDelay = 3000; // FAST 3-second polling while actively running!
            lastKnownRunId = latestRun.id;
            lastKnownStatus = 'in_progress';

            const activeStep = steps.find(s => s.status === 'in_progress');
            const btnLabel = activeStep ? activeStep.name.replace(/^Run Ingest Script$/, 'Ingesting').substring(0, 15) : 'Ingesting...';
            showActivityButton(btnLabel, true, 'amber');

          } else {
            // Run is completed
            if (lastKnownStatus === 'in_progress' && lastKnownRunId === latestRun.id) {
              // It just finished right now!
              lastKnownStatus = 'completed';
              showActivityButton(latestRun.conclusion === 'success' ? 'Done' : 'Failed', false, latestRun.conclusion === 'success' ? 'green' : 'red');
              if (latestRun.conclusion === 'success') {
                loadRepository(true); // Auto-refresh the file list
              }
              setTimeout(() => {
                setActivityButtonIdle();
              }, 7000);
            } else {
              setActivityButtonIdle();
            }

            nextDelay = 5000;
          }

        } else {
          renderActivityModal(null);
          setActivityButtonIdle();
          nextDelay = 6000;
        }

      } else {
        // GitHub API returned non-200 (e.g. 401/404)
        if (elements.activityModal && elements.activityModal.style.display === 'flex') {
          if (res.status === 401 || res.status === 403) {
            if (elements.activityStepInfo) elements.activityStepInfo.innerText = 'GitHub authentication error. Check GitHub Token.';
          } else if (res.status === 404) {
            if (elements.activityStepInfo) elements.activityStepInfo.innerText = `Workflow '${workflowFile}' not found in ${owner}/${repoName}.`;
          }
        }
        setActivityButtonIdle();
        nextDelay = 6000;
      }

    } catch (err) {
      console.warn('Error polling GitHub Actions API:', err);
      nextDelay = 6000;
    }

    // Schedule next poll ONLY if the modal is still open
    if (elements.activityModal && elements.activityModal.style.display === 'flex') {
      if (activeIngestionPollTimer) clearTimeout(activeIngestionPollTimer);
      activeIngestionPollTimer = setTimeout(() => pollActiveIngestion(false), nextDelay);
    } else {
      if (activeIngestionPollTimer) {
        clearTimeout(activeIngestionPollTimer);
        activeIngestionPollTimer = null;
      }
    }
  }

  function startActiveIngestionPolling() {
    if (activeIngestionPollTimer) clearTimeout(activeIngestionPollTimer);
    pollActiveIngestion(true);
  }

  function showImportModal() {
    if (!state.token) {
      showAuthModal('Please connect with your Hugging Face Token first.');
      return;
    }

    const savedGhToken = localStorage.getItem(storage.ghTokenKey) || '';
    const defaultGhRepo = (CONFIG.github?.owner && CONFIG.github?.repo) ? `${CONFIG.github.owner}/${CONFIG.github.repo}` : 'mnswamedia/trove';
    const savedGhRepo = localStorage.getItem(storage.ghRepoKey) || defaultGhRepo;

    if (elements.importGhToken) elements.importGhToken.value = savedGhToken;
    if (elements.importGhRepo) elements.importGhRepo.value = savedGhRepo;

    if (elements.ghConfigFields) {
      if (savedGhToken) {
        elements.ghConfigFields.classList.add('hidden');
      } else {
        elements.ghConfigFields.classList.remove('hidden');
      }
    }

    elements.importModal.style.display = 'flex';
    elements.importProgressBox.classList.add('hidden');
    elements.importErrorMsg.classList.add('hidden');
    elements.startImportBtn.disabled = false;
    elements.startImportBtn.classList.remove('opacity-50', 'pointer-events-none');
    setTimeout(() => elements.importUrlsInput.focus(), 50);
    if (window.lucide) window.lucide.createIcons();
  }

  function hideImportModal() {
    elements.importModal.style.display = 'none';
  }

  // Strip tracking/share parameters from YouTube URLs (?si=..., &feature=..., etc.)
  function cleanYouTubeUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return '';
    const trimmed = urlStr.trim();
    try {
      if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        return trimmed;
      }
      const u = new URL(trimmed);
      const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');

      if (host === 'youtu.be') {
        return `https://youtu.be${u.pathname}`;
      }
      if (host === 'youtube.com' || host === 'music.youtube.com') {
        if (u.pathname.startsWith('/shorts/')) {
          return `https://www.youtube.com${u.pathname}`;
        }
        if (u.pathname === '/watch' && u.searchParams.has('v')) {
          return `https://www.youtube.com/watch?v=${u.searchParams.get('v')}`;
        }
        return `https://www.youtube.com${u.pathname}`;
      }
      return trimmed;
    } catch (e) {
      return trimmed;
    }
  }

  function cleanAllInputUrls(text) {
    if (!text) return '';
    return text.split('\n').map(line => {
      return line.split(/\s+/).map(token => {
        if (token.includes('youtu.be') || token.includes('youtube.com')) {
          return cleanYouTubeUrl(token);
        }
        return token;
      }).join(' ');
    }).join('\n');
  }

  function showImportError(msg) {
    elements.importErrorMsg.innerText = msg;
    elements.importErrorMsg.classList.remove('hidden');
    elements.importProgressBox.classList.add('hidden');
  }

  function clearSelectedImportFile() {
    elements.importFileInput.value = '';
    elements.importFilenameDisplay.innerText = 'Select a .txt file (one link per line)';
    elements.importClearFileBtn.classList.add('hidden');
  }

  async function handleImportSubmit(e) {
    e.preventDefault();
    const urlsText = cleanAllInputUrls(elements.importUrlsInput.value.trim());
    elements.importUrlsInput.value = urlsText;
    const file = elements.importFileInput.files && elements.importFileInput.files[0];

    if (!urlsText && !file) {
      showImportError('Please enter at least one YouTube link or ID, or select a .txt file.');
      return;
    }

    const ghToken = (elements.importGhToken.value || '').trim() || localStorage.getItem(storage.ghTokenKey) || '';
    if (!ghToken) {
      showImportError('Please provide your GitHub Personal Access Token (with workflow scope) to run the ingestion.');
      if (elements.ghConfigFields) elements.ghConfigFields.classList.remove('hidden');
      if (elements.importGhToken) elements.importGhToken.focus();
      return;
    }

    // Persist GitHub credentials in localStorage
    localStorage.setItem(storage.ghTokenKey, ghToken);
    const defaultRepo = (CONFIG.github?.owner && CONFIG.github?.repo) ? `${CONFIG.github.owner}/${CONFIG.github.repo}` : 'mnswamedia/trove';
    const rawRepo = (elements.importGhRepo.value || '').trim() || localStorage.getItem(storage.ghRepoKey) || defaultRepo;
    localStorage.setItem(storage.ghRepoKey, rawRepo);

    const repoParts = rawRepo.split('/').map(s => s.trim());
    if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
      showImportError('Please enter the GitHub repository in "owner/repo" format (e.g. mnswamedia/trove).');
      return;
    }
    const [owner, repoName] = repoParts;

    // Collect targets (string from input + parsed lines from .txt file)
    let combinedTargets = urlsText;
    if (file) {
      try {
        const fileContent = await file.text();
        combinedTargets = (combinedTargets ? combinedTargets + '\n' : '') + fileContent;
      } catch (fErr) {
        showImportError('Failed to read the selected .txt file.');
        return;
      }
    }
    combinedTargets = cleanAllInputUrls(combinedTargets);

    const selectedFormat = document.querySelector('input[name="import-format"]:checked')?.value || 'm4a';
    const workflowFile = CONFIG.github?.workflowFile || 'ingest.yml';

    // Show Progress UI
    elements.importErrorMsg.classList.add('hidden');
    elements.importProgressBox.classList.remove('hidden');
    elements.importStatusText.innerText = 'Dispatching GitHub Actions workflow...';
    elements.importStatusSubtext.innerText = `Target: ${owner}/${repoName} (${workflowFile})`;
    elements.startImportBtn.disabled = true;
    elements.startImportBtn.classList.add('opacity-50', 'pointer-events-none');

    const triggerTime = Date.now();

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
          errDetail = `Workflow '${workflowFile}' not found in repository ${owner}/${repoName}. Make sure .github/workflows/${workflowFile} exists on the default branch.`;
        } else if (response.status === 401 || response.status === 403) {
          errDetail = `GitHub authentication failed. Check that your Personal Access Token is valid and has 'workflow' or 'repo' scope.`;
        }
        throw new Error(errDetail);
      }

      elements.importStatusText.innerText = 'Dispatched to GitHub Actions!';
      elements.importStatusSubtext.innerText = 'Opening live Activity Monitor...';

      setTimeout(() => {
        hideImportModal();
        elements.importUrlsInput.value = '';
        clearSelectedImportFile();
        elements.startImportBtn.disabled = false;
        elements.startImportBtn.classList.remove('opacity-50', 'pointer-events-none');
        
        // Activate Activity button and open Live Activity Modal immediately
        showActivityButton('Starting...', true, 'amber');
        showActivityModal();
        startActiveIngestionPolling();
      }, 700);

    } catch (err) {
      showImportError(err.message || 'Error triggering GitHub Actions runner.');
      elements.startImportBtn.disabled = false;
      elements.startImportBtn.classList.remove('opacity-50', 'pointer-events-none');
    }
  }

  // ==========================================
  // MEDIA PLAYER ENGINE
  // ==========================================
  const player = {
    currentTrack: null,
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    isLoading: false,
    isExpanded: false,
    isSeeking: false,
    shuffle: false,
    repeat: 'off', // 'off' | 'all' | 'one'
    playbackRates: [0.75, 1.0, 1.25, 1.5, 2.0],
    speedIndex: 1,
    savedStartTime: 0,
    blobCache: new Map(), // path -> { blob, url } (Rotated LRU: strictly max 10 to prevent memory bloat)
    thumbnailCache: new Map(), // path -> dataUrl or blobUrl

    // LRU Media Cache Rotation (Strictly max 10 items in memory; revokes URLs to prevent leaks)
    setMediaCache(path, entry) {
      if (this.blobCache.has(path)) {
        this.blobCache.delete(path);
      }

      while (this.blobCache.size >= MAX_MEDIA_CACHE) {
        const oldestKey = this.blobCache.keys().next().value;
        const oldEntry = this.blobCache.get(oldestKey);
        if (oldEntry && oldEntry.url) {
          try {
            URL.revokeObjectURL(oldEntry.url);
          } catch (e) {}
        }
        this.blobCache.delete(oldestKey);
      }

      this.blobCache.set(path, entry);
    },

    getActiveElement() {
      if (!this.currentTrack) return elements.playerAudio;
      return this.currentTrack.category === 'video' ? elements.playerVideo : elements.playerAudio;
    },

    getInactiveElement() {
      if (!this.currentTrack) return elements.playerVideo;
      return this.currentTrack.category === 'video' ? elements.playerAudio : elements.playerVideo;
    },

    // Build playback queue from current playable items
    updateQueue(clickedItem = null) {
      const playable = state.allItems.filter(i => !i.isDir && (i.category === 'music' || i.category === 'video'));
      this.queue = playable;

      if (clickedItem) {
        this.currentIndex = this.queue.findIndex(i => i.path === clickedItem.path);
      }
      this.updateQueueCounter();
    },

    updateQueueCounter() {
      if (this.queue.length === 0 || this.currentIndex < 0) {
        elements.activeQueueCounter.innerText = 'No media in queue';
      } else {
        elements.activeQueueCounter.innerText = `${this.currentIndex + 1} / ${this.queue.length} in queue`;
      }
    },

    // Extract ID3 Album Art from Blob (at 100% ORIGINAL QUALITY - zero compression)
    async extractThumbnail(blob, item) {
      if (this.thumbnailCache.has(item.path)) {
        return this.thumbnailCache.get(item.path);
      }

      // 1. Check persistent IndexedDB cache first
      const idbBlob = await getThumbnailBlobFromIDB(item.path);
      if (idbBlob) {
        const thumbUrl = URL.createObjectURL(idbBlob);
        this.thumbnailCache.set(item.path, thumbUrl);
        return thumbUrl;
      }

      // 2. Extract original picture from ID3 tags
      if (item.category === 'music' && window.jsmediatags) {
        try {
          const thumbBlob = await new Promise((resolve) => {
            window.jsmediatags.read(blob, {
              onSuccess: (tag) => {
                const picture = tag.tags?.picture;
                if (picture && picture.data && picture.data.length > 0) {
                  try {
                    const byteArray = new Uint8Array(picture.data);
                    const mimeType = picture.format || 'image/jpeg';
                    const imgBlob = new Blob([byteArray], { type: mimeType });
                    resolve(imgBlob);
                    return;
                  } catch (e) {
                    console.warn('Error creating picture blob:', e);
                  }
                }
                resolve(null);
              },
              onError: () => {
                resolve(null);
              }
            });
          });

          if (thumbBlob) {
            const thumbUrl = URL.createObjectURL(thumbBlob);
            this.thumbnailCache.set(item.path, thumbUrl);
            saveThumbnailBlobToIDB(item.path, thumbBlob);
            return thumbUrl;
          }
        } catch (e) {
          console.warn('jsmediatags extraction failed:', e);
        }
      }
      return null;
    },

    // Update thumbnail in Play Bar and Expanded Disc
    updateThumbnailUI(thumbUrl, item) {
      const isVideo = item.category === 'video';

      // Bottom Play Bar Thumbnail
      if (thumbUrl) {
        elements.barThumbImg.src = thumbUrl;
        elements.barThumbImg.classList.remove('hidden');
        elements.barTypeIcon.classList.add('hidden');
      } else {
        elements.barThumbImg.removeAttribute('src');
        elements.barThumbImg.classList.add('hidden');
        elements.barTypeIcon.classList.remove('hidden');
        elements.barTypeIcon.setAttribute('data-lucide', isVideo ? 'video' : 'music');
      }

      // Expanded Direct Cover Art Card
      if (thumbUrl && !isVideo) {
        elements.expandedCoverImg.src = thumbUrl;
        elements.expandedCoverImg.classList.remove('hidden');
        elements.expandedCoverFallback.classList.add('hidden');
      } else {
        elements.expandedCoverImg.removeAttribute('src');
        elements.expandedCoverImg.classList.add('hidden');
        elements.expandedCoverFallback.classList.remove('hidden');
        elements.expandedCoverIcon.setAttribute('data-lucide', isVideo ? 'video' : 'music');
      }

      if (window.lucide) window.lucide.createIcons();

      // Keep native Lock Screen / Notification MediaSession artwork in sync
      if (thumbUrl && this.currentTrack && item && this.currentTrack.path === item.path) {
        this.updateMediaSession(thumbUrl);
      }
    },

    // Fetch media file: Memory Cache -> Persistent IndexedDB -> Hugging Face Network Fetch
    async getMediaBlobAndUrl(item) {
      // 1. In-memory RAM cache check
      if (this.blobCache.has(item.path)) {
        return this.blobCache.get(item.path);
      }

      // 2. Persistent IndexedDB cache check (Instant replay for last 10 songs without network)
      const cachedBlob = await getMediaFromIDB(item.path);
      if (cachedBlob) {
        const mimeType = item.category === 'music' ? 'audio/mpeg' : 'video/mp4';
        const typedBlob = cachedBlob.type ? cachedBlob : new Blob([cachedBlob], { type: mimeType });
        const blobUrl = URL.createObjectURL(typedBlob);
        const entry = { blob: typedBlob, url: blobUrl };
        this.setMediaCache(item.path, entry);
        return entry;
      }

      // 3. Network fetch from Hugging Face Storage Bucket
      // Encode path segments properly: converts spaces (%20), emojis, fullwidth chars, and especially '#' to '%23'
      // so browser does not truncate the URL at '#' (hash fragment)
      const encodedPath = item.path.split('/').map(seg => encodeURIComponent(seg)).join('/');
      const candidateUrls = [
        `https://huggingface.co/buckets/${repo.id}/resolve/${encodedPath}`,
        `https://huggingface.co/buckets/${repo.id}/raw/${encodedPath}`,
        `${api.bucketsBase}/${repo.id}/raw/${encodedPath}`,
        `${api.bucketsBase}/${repo.id}/resolve/${encodedPath}`,
        `https://huggingface.co/api/buckets/${repo.id}/raw/${encodedPath}`,
        `https://huggingface.co/datasets/${repo.id}/resolve/main/${encodedPath}`,
        `https://huggingface.co/datasets/${repo.id}/raw/main/${encodedPath}`,
        `${api.datasetsBase}/${repo.id}/resolve/main/${encodedPath}`
      ];

      let lastErr = null;
      for (const url of candidateUrls) {
        try {
          const res = await fetch(url, {
            headers: {
              'Authorization': `Bearer ${state.token}`
            }
          });
          if (res.ok) {
            const blob = await res.blob();
            const mimeType = item.category === 'music' ? 'audio/mpeg' : 'video/mp4';
            const typedBlob = blob.type ? blob : new Blob([blob], { type: mimeType });
            const blobUrl = URL.createObjectURL(typedBlob);
            const entry = { blob: typedBlob, url: blobUrl };
            this.setMediaCache(item.path, entry);
            saveMediaToIDB(item.path, typedBlob); // Persist to IndexedDB (max 10 rotated)
            return entry;
          }
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('Failed to load media file from bucket.');
    },

    // Play a given item (clean transition: stop old -> reset UI -> download -> play)
    async playTrack(item, startAtSeconds = 0) {
      if (!item || item.isDir) return;

      // 1. IMMEDIATELY STOP current playing media
      const activeEl = this.getActiveElement();
      if (activeEl) {
        activeEl.pause();
        activeEl.currentTime = 0;
        activeEl.removeAttribute('src');
        activeEl.load();
      }
      const inactiveEl = this.getInactiveElement();
      if (inactiveEl) {
        inactiveEl.pause();
        inactiveEl.currentTime = 0;
        inactiveEl.removeAttribute('src');
        inactiveEl.load();
      }

      // 2. IMMEDIATELY RESET UI & Progress
      this.isPlaying = false;
      this.currentTrack = item;
      this.updateQueue(item);

      elements.barProgressSlider.value = 0;
      elements.expandedProgressSlider.value = 0;
      elements.barTimeCurrent.innerText = formatTime(startAtSeconds);
      elements.expandedTimeCurrent.innerText = formatTime(startAtSeconds);
      elements.barTimeDuration.innerText = '--:--';
      elements.expandedTimeDuration.innerText = '--:--';

      // Update text immediately so user sees what is being loaded
      elements.barTrackTitle.innerText = item.name;
      elements.barTrackExt.innerText = item.label || 'MEDIA';
      elements.expandedTrackTitle.innerText = item.name;
      elements.expandedTrackMeta.innerText = `${item.label} • ${formatBytes(item.size)} • ${item.parentDir || 'Root'}`;
      elements.expandedSubtitle.innerText = `${repo.id} / ${item.parentDir || 'Vault'}`;

      // Reset thumbnail to cached or default
      const cachedThumb = this.thumbnailCache.get(item.path) || null;
      this.updateThumbnailUI(cachedThumb, item);

      // Icon & stage configuration
      const isVideo = item.category === 'video';
      if (isVideo) {
        elements.stageVideo.classList.remove('hidden');
        elements.stageMusic.classList.add('hidden');
        elements.btnPipToggle.classList.remove('hidden');
      } else {
        elements.stageVideo.classList.add('hidden');
        elements.stageMusic.classList.remove('hidden');
        elements.btnPipToggle.classList.add('hidden');
      }

      // 3. SHOW LOADING STATE IN BAR & BUTTONS
      this.showBottomBar();
      this.setLoading(true);
      render(); // Refresh list to highlight new active row

      // 4. FETCH, EXTRACT THUMBNAIL, AND PLAY
      try {
        const mediaEntry = await this.getMediaBlobAndUrl(item);

        // Extract ID3 thumbnail if not yet cached
        let thumbUrl = this.thumbnailCache.get(item.path);
        if (!thumbUrl && mediaEntry.blob) {
          thumbUrl = await this.extractThumbnail(mediaEntry.blob, item);
        }
        this.updateThumbnailUI(thumbUrl, item);

        const targetEl = this.getActiveElement();
        targetEl.src = mediaEntry.url;
        targetEl.playbackRate = this.playbackRates[this.speedIndex];
        
        if (startAtSeconds > 0) {
          targetEl.currentTime = startAtSeconds;
          this.savedStartTime = 0;
        }

        await targetEl.play();
        this.isPlaying = true;
        this.updatePlayStateUI();
        this.updateMediaSession(thumbUrl);

        addRecentTrack(item, startAtSeconds, targetEl.duration || 0);
        savePlaybackState();
      } catch (err) {
        console.error('Playback failed:', err);
        alert(`Failed to load ${item.name}: ${err.message}`);
        this.isPlaying = false;
        this.updatePlayStateUI();
      } finally {
        this.setLoading(false);
      }
    },

    setLoading(loading) {
      this.isLoading = loading;
      if (loading) {
        elements.barLoadingBadge.classList.remove('hidden');
        elements.btnPlayPause.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin text-white"></i>';
        elements.btnExpandedPlay.innerHTML = '<i data-lucide="loader-2" class="w-7 h-7 animate-spin text-white"></i>';
        elements.videoLoadingOverlay.classList.remove('hidden');
      } else {
        elements.barLoadingBadge.classList.add('hidden');
        elements.videoLoadingOverlay.classList.add('hidden');
        this.updatePlayStateUI();
      }
      if (window.lucide) window.lucide.createIcons();
    },

    async togglePlayPause() {
      if (!this.currentTrack) {
        if (this.queue.length > 0) {
          this.playTrack(this.queue[0]);
        }
        return;
      }

      const activeEl = this.getActiveElement();
      // If media element src not yet bound (e.g. freshly restored from localStorage)
      if (!activeEl.src || activeEl.src === '' || activeEl.src === window.location.href) {
        await this.playTrack(this.currentTrack, this.savedStartTime || 0);
        return;
      }

      if (activeEl.paused) {
        activeEl.play().then(() => {
          this.isPlaying = true;
          this.updatePlayStateUI();
          savePlaybackState();
        }).catch(console.error);
      } else {
        activeEl.pause();
        this.isPlaying = false;
        this.updatePlayStateUI();
        savePlaybackState();
      }
    },

    resume() {
      const activeEl = this.getActiveElement();
      if (activeEl && activeEl.paused) {
        activeEl.play().catch(console.error);
      }
    },

    pause() {
      const activeEl = this.getActiveElement();
      if (activeEl && !activeEl.paused) {
        activeEl.pause();
      }
    },

    playNext() {
      if (this.queue.length === 0) return;

      if (this.repeat === 'one') {
        const activeEl = this.getActiveElement();
        activeEl.currentTime = 0;
        activeEl.play().catch(console.error);
        return;
      }

      let nextIndex;
      if (this.shuffle) {
        nextIndex = Math.floor(Math.random() * this.queue.length);
      } else {
        nextIndex = this.currentIndex + 1;
        if (nextIndex >= this.queue.length) {
          if (this.repeat === 'all') {
            nextIndex = 0;
          } else {
            this.isPlaying = false;
            this.updatePlayStateUI();
            return;
          }
        }
      }

      this.playTrack(this.queue[nextIndex]);
    },

    playPrev() {
      if (this.queue.length === 0) return;

      const activeEl = this.getActiveElement();
      if (activeEl.currentTime > 3) {
        activeEl.currentTime = 0;
        return;
      }

      let prevIndex = this.currentIndex - 1;
      if (prevIndex < 0) {
        prevIndex = this.repeat === 'all' ? this.queue.length - 1 : 0;
      }

      this.playTrack(this.queue[prevIndex]);
    },

    seekTo(seconds) {
      const activeEl = this.getActiveElement();
      if (activeEl && !isNaN(activeEl.duration)) {
        activeEl.currentTime = Math.max(0, Math.min(seconds, activeEl.duration));
      }
    },

    seekDelta(delta) {
      const activeEl = this.getActiveElement();
      if (activeEl && !isNaN(activeEl.duration)) {
        activeEl.currentTime = Math.max(0, Math.min(activeEl.currentTime + delta, activeEl.duration));
      }
    },

    // Accurately update Play/Pause buttons with fresh Lucide icons
    updatePlayStateUI() {
      if (this.isLoading) return;

      const icon = this.isPlaying ? 'pause' : 'play';
      elements.btnPlayPause.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4 ml-0.5 text-white"></i>`;
      elements.btnExpandedPlay.innerHTML = `<i data-lucide="${icon}" class="w-7 h-7 ml-0.5 text-white"></i>`;

      if (this.isPlaying) {
        elements.barPlayingIndicator.classList.remove('hidden');
        if (elements.expandedCoverArt) {
          elements.expandedCoverArt.classList.add('ring-2', 'ring-khaki-beige/40');
        }
      } else {
        elements.barPlayingIndicator.classList.add('hidden');
        if (elements.expandedCoverArt) {
          elements.expandedCoverArt.classList.remove('ring-2', 'ring-khaki-beige/40');
        }
      }

      if (window.lucide) window.lucide.createIcons();
    },

    // Floating Play Bar Appearance
    showBottomBar() {
      elements.bottomPlayBar.style.display = 'block';
      setTimeout(() => {
        elements.bottomPlayBar.classList.remove('translate-y-28', 'opacity-0', 'pointer-events-none');
        elements.bottomPlayBar.classList.add('translate-y-0', 'opacity-100', 'pointer-events-auto');
      }, 10);
      document.body.classList.add('pb-28');
    },

    expand() {
      this.isExpanded = true;
      elements.expandedPlayer.style.display = 'flex';
      setTimeout(() => {
        elements.expandedPlayer.classList.remove('translate-y-full');
        elements.expandedPlayer.classList.add('translate-y-0');
      }, 10);
      savePlaybackState();
    },

    minimize() {
      this.isExpanded = false;
      elements.expandedPlayer.classList.remove('translate-y-0');
      elements.expandedPlayer.classList.add('translate-y-full');
      setTimeout(() => {
        if (!this.isExpanded) elements.expandedPlayer.style.display = 'none';
      }, 300);
      savePlaybackState();
    },

    toggleShuffle() {
      this.shuffle = !this.shuffle;
      if (this.shuffle) {
        elements.btnShuffle.classList.add('text-jet-black', 'font-bold');
        elements.btnShuffle.classList.remove('text-stone-brown/50');
        elements.btnShuffle.title = 'Shuffle On';
      } else {
        elements.btnShuffle.classList.remove('text-jet-black', 'font-bold');
        elements.btnShuffle.classList.add('text-stone-brown/50');
        elements.btnShuffle.title = 'Shuffle Off';
      }
      savePlaybackState();
    },

    toggleRepeat() {
      if (this.repeat === 'off') {
        this.repeat = 'all';
        elements.btnRepeat.setAttribute('title', 'Repeat All');
        elements.btnRepeat.classList.add('text-jet-black', 'font-bold');
        elements.btnRepeat.classList.remove('text-stone-brown/50');
        elements.btnRepeat.innerHTML = '<i data-lucide="repeat" class="w-5 h-5"></i>';
      } else if (this.repeat === 'all') {
        this.repeat = 'one';
        elements.btnRepeat.setAttribute('title', 'Repeat One');
        elements.btnRepeat.innerHTML = '<i data-lucide="repeat-1" class="w-5 h-5"></i>';
      } else {
        this.repeat = 'off';
        elements.btnRepeat.setAttribute('title', 'Repeat Off');
        elements.btnRepeat.classList.remove('text-jet-black', 'font-bold');
        elements.btnRepeat.classList.add('text-stone-brown/50');
        elements.btnRepeat.innerHTML = '<i data-lucide="repeat" class="w-5 h-5"></i>';
      }
      if (window.lucide) window.lucide.createIcons();
      savePlaybackState();
    },

    cycleSpeed() {
      this.speedIndex = (this.speedIndex + 1) % this.playbackRates.length;
      const rate = this.playbackRates[this.speedIndex];
      elements.btnSpeed.innerText = `${rate}x`;
      elements.playerAudio.playbackRate = rate;
      elements.playerVideo.playbackRate = rate;
      savePlaybackState();
    },

    // Native Lock Screen, Notification Shade & Media Controls (MediaSession API with High-Res Artwork)
    updateMediaSession(thumbUrl = null) {
      if (!('mediaSession' in navigator) || !this.currentTrack) return;

      const track = this.currentTrack;
      let cleanTitle = track.name.replace(/\.[a-zA-Z0-9]+$/, '');
      let cleanArtist = repo.id ? `Trove (${repo.id})` : 'Trove Vault';
      let cleanAlbum = track.parentDir || 'Trove Media Vault';

      // Parse "Artist - Title" if formatted with dash
      if (cleanTitle.includes(' - ')) {
        const parts = cleanTitle.split(' - ');
        cleanArtist = parts[0].trim();
        cleanTitle = parts.slice(1).join(' - ').trim();
      }

      const artworkList = thumbUrl ? [
        { src: thumbUrl, sizes: '512x512', type: 'image/jpeg' },
        { src: thumbUrl, sizes: '256x256', type: 'image/jpeg' },
        { src: './assets/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' }
      ] : [
        { src: './assets/icons/icon-96x96.png', sizes: '96x96', type: 'image/png' },
        { src: './assets/icons/icon-128x128.png', sizes: '128x128', type: 'image/png' },
        { src: './assets/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: './assets/icons/icon-384x384.png', sizes: '384x384', type: 'image/png' },
        { src: './assets/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' }
      ];

      navigator.mediaSession.metadata = new MediaMetadata({
        title: cleanTitle,
        artist: cleanArtist,
        album: cleanAlbum,
        artwork: artworkList
      });

      // Synchronize native playback state
      navigator.mediaSession.playbackState = this.isPlaying ? 'playing' : 'paused';

      try {
        navigator.mediaSession.setActionHandler('play', () => this.resume());
        navigator.mediaSession.setActionHandler('pause', () => this.pause());
        navigator.mediaSession.setActionHandler('stop', () => this.pause());
        navigator.mediaSession.setActionHandler('previoustrack', () => this.playPrev());
        navigator.mediaSession.setActionHandler('nexttrack', () => this.playNext());
        navigator.mediaSession.setActionHandler('seekto', (details) => {
          if (details.seekTime != null) this.seekTo(details.seekTime);
        });
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
          this.seekDelta(-(details.seekOffset || 10));
        });
        navigator.mediaSession.setActionHandler('seekforward', (details) => {
          this.seekDelta(details.seekOffset || 10);
        });
      } catch (err) {
        console.warn('MediaSession handler registration warning:', err);
      }
    }
  };

  // Setup Media Element Listeners
  let lastTimeUpdateSave = 0;

  function setupMediaElementEvents(el) {
    el.addEventListener('timeupdate', (e) => {
      if (el !== player.getActiveElement()) return;

      const cur = el.currentTime || 0;
      const dur = el.duration || 0;
      const pct = dur > 0 ? (cur / dur) * 100 : 0;

      if (!player.isSeeking) {
        elements.barProgressSlider.value = pct;
        elements.expandedProgressSlider.value = pct;
      }

      elements.barTimeCurrent.innerText = formatTime(cur);
      elements.expandedTimeCurrent.innerText = formatTime(cur);

      if (dur > 0 && !isNaN(dur)) {
        elements.barTimeDuration.innerText = formatTime(dur);
        elements.expandedTimeDuration.innerText = formatTime(dur);
      }

      // Android/Desktop background playback position sync
      if ('mediaSession' in navigator && dur > 0 && !isNaN(dur)) {
        try {
          navigator.mediaSession.setPositionState({
            duration: dur,
            playbackRate: el.playbackRate || 1.0,
            position: Math.min(cur, dur)
          });
        } catch (err) {}
      }

      // Throttle saving playback state to localStorage every 2.5 seconds
      const now = Date.now();
      if (now - lastTimeUpdateSave > 2500) {
        lastTimeUpdateSave = now;
        savePlaybackState();
      }
    });

    el.addEventListener('play', () => {
      if (el === player.getActiveElement()) {
        player.isPlaying = true;
        player.updatePlayStateUI();
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
        savePlaybackState();
      }
    });

    el.addEventListener('pause', () => {
      if (el === player.getActiveElement()) {
        player.isPlaying = false;
        player.updatePlayStateUI();
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'paused';
        }
        savePlaybackState();
      }
    });

    el.addEventListener('ended', () => {
      if (el === player.getActiveElement()) {
        player.playNext();
        savePlaybackState();
      }
    });
  }

  setupMediaElementEvents(elements.playerAudio);
  setupMediaElementEvents(elements.playerVideo);

  // Update Single View Toggle Button UI
  function updateViewToggleUI() {
    if (!elements.viewToggleBtn) return;
    const isTree = state.viewMode === 'tree';
    elements.viewToggleBtn.title = isTree 
      ? 'Current: Tree View. Click to switch to Flat View.' 
      : 'Current: Flat View. Click to switch to Tree View.';
    elements.viewToggleBtn.innerHTML = `<i data-lucide="${isTree ? 'folder-tree' : 'list'}" class="w-4 h-4"></i>`;
    if (window.lucide) window.lucide.createIcons();
  }

  // Update Filter Dropdown UI
  function updateFilterDropdownUI() {
    const config = FILTER_CONFIG[state.filterType] || { label: state.filterType, fullLabel: state.filterType, icon: 'filter' };
    if (elements.filterActiveLabel) {
      elements.filterActiveLabel.innerText = config.label;
    }
    if (elements.filterActiveIcon) {
      elements.filterActiveIcon.setAttribute('data-lucide', config.icon);
    }
    if (elements.filterDropdownMenu) {
      elements.filterDropdownMenu.querySelectorAll('.filter-option').forEach(opt => {
        const checkIcon = opt.querySelector('.filter-check-icon');
        const isActive = opt.dataset.filter === state.filterType;
        if (checkIcon) {
          if (isActive) checkIcon.classList.remove('hidden');
          else checkIcon.classList.add('hidden');
        }
        if (isActive) {
          opt.classList.add('bg-almond-cream/50', 'font-semibold');
        } else {
          opt.classList.remove('bg-almond-cream/50', 'font-semibold');
        }
      });
    }
    if (window.lucide) window.lucide.createIcons();
  }

  // Setup Event Handlers
  function setupEventListeners() {
    // Auth Form Submit
    elements.authForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const inputVal = elements.hfTokenInput.value.trim();
      if (!inputVal) return;

      state.token = inputVal;
      localStorage.setItem(storage.tokenKey, inputVal);
      hideAuthModal();
      if (elements.authBtnLabel) elements.authBtnLabel.innerText = 'Connected';
      if (elements.authSettingsBtn) elements.authSettingsBtn.title = 'Hugging Face Access Token (Connected)';
      loadRepository(true);
    });

    elements.closeModalBtn.addEventListener('click', () => {
      hideAuthModal();
    });

    elements.authSettingsBtn.addEventListener('click', () => {
      showAuthModal();
    });

    // Toggle Password Visibility
    elements.toggleTokenVisibility.addEventListener('click', () => {
      const isPass = elements.hfTokenInput.getAttribute('type') === 'password';
      elements.hfTokenInput.setAttribute('type', isPass ? 'text' : 'password');
      const icon = elements.toggleTokenVisibility.querySelector('i');
      if (icon) {
        icon.setAttribute('data-lucide', isPass ? 'eye-off' : 'eye');
        if (window.lucide) window.lucide.createIcons();
      }
    });

    // Refresh Button (Forces 1-hour cache bypass)
    elements.refreshBtn.addEventListener('click', () => {
      loadRepository(true);
    });

    // Search Input
    elements.searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value.trim();
      if (state.searchQuery) {
        elements.clearSearchBtn.classList.remove('hidden');
      } else {
        elements.clearSearchBtn.classList.add('hidden');
      }
      render();
    });

    elements.clearSearchBtn.addEventListener('click', () => {
      elements.searchInput.value = '';
      state.searchQuery = '';
      elements.clearSearchBtn.classList.add('hidden');
      render();
    });

    // View Toggle Button (Tree <-> Flat Single Icon Button)
    if (elements.viewToggleBtn) {
      elements.viewToggleBtn.addEventListener('click', () => {
        state.viewMode = state.viewMode === 'tree' ? 'flat' : 'tree';
        updateViewToggleUI();
        saveViewSettings();
        render();
      });
    }

    // Filter Dropdown Interactions
    if (elements.filterDropdownBtn && elements.filterDropdownMenu) {
      elements.filterDropdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        elements.filterDropdownMenu.classList.toggle('hidden');
      });

      elements.filterDropdownMenu.addEventListener('click', (e) => {
        const option = e.target.closest('.filter-option');
        if (!option) return;
        state.filterType = option.dataset.filter || 'all';
        updateFilterDropdownUI();
        elements.filterDropdownMenu.classList.add('hidden');
        saveViewSettings();
        render();
      });

      document.addEventListener('click', (e) => {
        if (!elements.filterDropdownMenu.classList.contains('hidden')) {
          const container = document.getElementById('filter-dropdown-container');
          if (container && !container.contains(e.target)) {
            elements.filterDropdownMenu.classList.add('hidden');
          }
        }
      });
    }

    // Breadcrumb clicks
    elements.breadcrumbs.addEventListener('click', (e) => {
      const item = e.target.closest('.breadcrumb-item');
      if (item && item.dataset.dir !== undefined) {
        state.currentDirectory = item.dataset.dir;
        saveViewSettings();
        render();
      }
    });

    // File list delegation (Folder navigation, Media playback, or Native Browser New Tab)
    elements.fileList.addEventListener('click', (e) => {
      const parentRow = e.target.closest('[data-action="go-parent"]');
      if (parentRow) {
        const parts = state.currentDirectory.split('/');
        parts.pop();
        state.currentDirectory = parts.join('/');
        saveViewSettings();
        render();
        return;
      }

      const row = e.target.closest('.file-row');
      if (!row) return;

      const isDir = row.dataset.isDir === 'true';
      const path = row.dataset.path;

      if (isDir) {
        state.currentDirectory = path;
        saveViewSettings();
        render();
      } else {
        const item = state.allItems.find(i => i.path === path);
        if (!item) return;
        if (item.category === 'music' || item.category === 'video') {
          player.playTrack(item);
        } else {
          // Open other files (txt, json, doc, etc.) in a new tab for native browser handling
          const encodedPath = item.path.split('/').map(seg => encodeURIComponent(seg)).join('/');
          const fileUrl = `https://huggingface.co/buckets/${repo.id}/resolve/${encodedPath}`;
          window.open(fileUrl, '_blank', 'noopener,noreferrer');
        }
      }
    });

    // Player Play/Pause Buttons
    elements.btnPlayPause.addEventListener('click', (e) => {
      e.stopPropagation();
      player.togglePlayPause();
    });

    elements.btnExpandedPlay.addEventListener('click', () => {
      player.togglePlayPause();
    });

    // Skip Next & Previous Buttons
    elements.btnNext.addEventListener('click', (e) => {
      e.stopPropagation();
      player.playNext();
    });
    elements.btnExpandedNext.addEventListener('click', () => {
      player.playNext();
    });

    elements.btnPrev.addEventListener('click', (e) => {
      e.stopPropagation();
      player.playPrev();
    });
    elements.btnExpandedPrev.addEventListener('click', () => {
      player.playPrev();
    });

    // Expand & Minimize Triggers
    elements.barExpandTrigger.addEventListener('click', () => {
      player.expand();
    });

    elements.btnExpandPlayer.addEventListener('click', (e) => {
      e.stopPropagation();
      player.expand();
    });

    elements.btnMinimizePlayer.addEventListener('click', () => {
      player.minimize();
    });

    // Scrubber Sliders
    const setupSlider = (slider) => {
      slider.addEventListener('mousedown', () => { player.isSeeking = true; });
      slider.addEventListener('touchstart', () => { player.isSeeking = true; });

      slider.addEventListener('input', (e) => {
        const activeEl = player.getActiveElement();
        if (activeEl && activeEl.duration) {
          const targetSec = (e.target.value / 100) * activeEl.duration;
          elements.barTimeCurrent.innerText = formatTime(targetSec);
          elements.expandedTimeCurrent.innerText = formatTime(targetSec);
        }
      });

      const finishSeeking = (e) => {
        if (!player.isSeeking) return;
        player.isSeeking = false;
        const activeEl = player.getActiveElement();
        if (activeEl && activeEl.duration) {
          activeEl.currentTime = (e.target.value / 100) * activeEl.duration;
          savePlaybackState();
        }
      };

      slider.addEventListener('mouseup', finishSeeking);
      slider.addEventListener('touchend', finishSeeking);
      slider.addEventListener('change', finishSeeking);
    };

    setupSlider(elements.barProgressSlider);
    setupSlider(elements.expandedProgressSlider);

    // Shuffle & Repeat
    elements.btnShuffle.addEventListener('click', () => player.toggleShuffle());
    elements.btnRepeat.addEventListener('click', () => player.toggleRepeat());

    // Playback Speed
    elements.btnSpeed.addEventListener('click', () => player.cycleSpeed());

    // Volume & Mute
    elements.volumeSlider.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      elements.playerAudio.volume = vol;
      elements.playerVideo.volume = vol;
      player.volume = vol;
      if (vol === 0) {
        elements.volumeIcon.setAttribute('data-lucide', 'volume-x');
      } else if (vol < 0.5) {
        elements.volumeIcon.setAttribute('data-lucide', 'volume-1');
      } else {
        elements.volumeIcon.setAttribute('data-lucide', 'volume-2');
      }
      if (window.lucide) window.lucide.createIcons();
      savePlaybackState();
    });

    elements.btnMute.addEventListener('click', () => {
      const activeEl = player.getActiveElement();
      activeEl.muted = !activeEl.muted;
      elements.volumeIcon.setAttribute('data-lucide', activeEl.muted ? 'volume-x' : 'volume-2');
      if (window.lucide) window.lucide.createIcons();
      savePlaybackState();
    });

    // Picture-in-Picture Toggle for Video
    elements.btnPipToggle.addEventListener('click', async () => {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture().catch(console.error);
      } else if (elements.playerVideo.requestPictureInPicture) {
        await elements.playerVideo.requestPictureInPicture().catch(console.error);
      }
    });

    // Import Modal Listeners
    if (elements.importBtn) {
      elements.importBtn.addEventListener('click', showImportModal);
    }
    if (elements.closeImportModalBtn) {
      elements.closeImportModalBtn.addEventListener('click', hideImportModal);
    }
    if (elements.cancelImportBtn) {
      elements.cancelImportBtn.addEventListener('click', hideImportModal);
    }
    if (elements.importModal) {
      elements.importModal.addEventListener('click', (e) => {
        if (e.target === elements.importModal) hideImportModal();
      });
    }

    // Live Ingestion Activity Modal Listeners
    if (elements.activityBtn) {
      elements.activityBtn.addEventListener('click', showActivityModal);
    }
    if (elements.closeActivityModalBtn) {
      elements.closeActivityModalBtn.addEventListener('click', hideActivityModal);
    }
    if (elements.dismissActivityBtn) {
      elements.dismissActivityBtn.addEventListener('click', hideActivityModal);
    }
    if (elements.activityModal) {
      elements.activityModal.addEventListener('click', (e) => {
        if (e.target === elements.activityModal) hideActivityModal();
      });
    }
    if (elements.importForm) {
      elements.importForm.addEventListener('submit', handleImportSubmit);
    }
    if (elements.importUrlsInput) {
      elements.importUrlsInput.addEventListener('paste', () => {
        setTimeout(() => {
          elements.importUrlsInput.value = cleanAllInputUrls(elements.importUrlsInput.value);
        }, 0);
      });
      elements.importUrlsInput.addEventListener('change', () => {
        elements.importUrlsInput.value = cleanAllInputUrls(elements.importUrlsInput.value);
      });
    }
    if (elements.importFileDropzone && elements.importFileInput) {
      elements.importFileDropzone.addEventListener('click', (e) => {
        if (e.target !== elements.importClearFileBtn) {
          elements.importFileInput.click();
        }
      });
      elements.importFileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) {
          elements.importFilenameDisplay.innerText = file.name;
          elements.importClearFileBtn.classList.remove('hidden');
        } else {
          clearSelectedImportFile();
        }
      });
      // Drag & Drop for .txt batch file
      elements.importFileDropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        elements.importFileDropzone.classList.add('bg-almond-cream/60', 'border-warm-sand');
      });
      elements.importFileDropzone.addEventListener('dragleave', () => {
        elements.importFileDropzone.classList.remove('bg-almond-cream/60', 'border-warm-sand');
      });
      elements.importFileDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        elements.importFileDropzone.classList.remove('bg-almond-cream/60', 'border-warm-sand');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          elements.importFileInput.files = e.dataTransfer.files;
          const file = e.dataTransfer.files[0];
          elements.importFilenameDisplay.innerText = file.name;
          elements.importClearFileBtn.classList.remove('hidden');
        }
      });
    }
    if (elements.importClearFileBtn) {
      elements.importClearFileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearSelectedImportFile();
      });
    }

    if (elements.toggleGhConfigBtn && elements.ghConfigFields) {
      elements.toggleGhConfigBtn.addEventListener('click', () => {
        elements.ghConfigFields.classList.toggle('hidden');
      });
    }

    // Format radio pills in Import Modal
    document.querySelectorAll('.import-format-radio').forEach(radio => {
      radio.addEventListener('change', () => {
        document.querySelectorAll('.import-format-pill').forEach(pill => {
          pill.classList.remove('active', 'bg-white', 'text-jet-black', 'shadow-sm');
          pill.classList.add('text-stone-brown');
        });
        const activeLabel = radio.closest('label');
        if (activeLabel) {
          const activePill = activeLabel.querySelector('.import-format-pill');
          if (activePill) {
            activePill.classList.add('active', 'bg-white', 'text-jet-black', 'shadow-sm');
            activePill.classList.remove('text-stone-brown');
          }
        }
      });
    });

    // Unload hook to persist final states
    window.addEventListener('beforeunload', () => {
      savePlaybackState();
      saveViewSettings();
    });

    // PWA Install Button & BeforeInstallPrompt Listener
    let deferredInstallPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (elements.pwaInstallBtn) {
        elements.pwaInstallBtn.classList.remove('hidden');
        if (window.lucide) window.lucide.createIcons();
      }
    });

    if (elements.pwaInstallBtn) {
      elements.pwaInstallBtn.addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') {
          console.log('User accepted Trove PWA install');
        }
        deferredInstallPrompt = null;
        elements.pwaInstallBtn.classList.add('hidden');
      });
    }

    window.addEventListener('appinstalled', () => {
      console.log('Trove PWA installed successfully');
      if (elements.pwaInstallBtn) elements.pwaInstallBtn.classList.add('hidden');
      deferredInstallPrompt = null;
    });

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      // Ignore if user is typing in search or input fields
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        player.togglePlayPause();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        player.seekDelta(5);
        savePlaybackState();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        player.seekDelta(-5);
        savePlaybackState();
      } else if (e.code === 'KeyN') {
        e.preventDefault();
        player.playNext();
      } else if (e.code === 'KeyP') {
        e.preventDefault();
        player.playPrev();
      } else if (e.code === 'KeyM') {
        e.preventDefault();
        elements.btnMute.click();
      } else if (e.code === 'Escape') {
        if (elements.activityModal && elements.activityModal.style.display === 'flex') {
          e.preventDefault();
          hideActivityModal();
        } else if (elements.importModal && elements.importModal.style.display === 'flex') {
          e.preventDefault();
          hideImportModal();
        } else if (player.isExpanded) {
          e.preventDefault();
          player.minimize();
        }
      }
    });
  }

  // Escape HTML helper
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Initialize
  function init() {
    if (elements.repoIdDisplay) elements.repoIdDisplay.innerText = repo.id;
    if (elements.modalRepoId) elements.modalRepoId.innerText = repo.id;
    if (elements.authUsername) elements.authUsername.value = repo.owner || 'mnswa';
    if (elements.repoBadge) elements.repoBadge.innerText = repo.isPrivate ? 'Private Bucket' : 'Public Bucket';

    loadSavedViewSettings();
    loadStoredThumbnails();
    setupEventListeners();

    // Register Service Worker for PWA (Offline Shell & Fast Launch)
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { scope: './' })
          .then((reg) => {
            console.log('Trove ServiceWorker active with scope:', reg.scope);
          })
          .catch((err) => {
            console.warn('Trove ServiceWorker registration note:', err);
          });
      });
    }

    // Sync restored view mode & filters with UI
    updateViewToggleUI();
    updateFilterDropdownUI();

    // Restore playbar and playback progress
    restorePlaybackState();

    if (window.lucide) {
      window.lucide.createIcons();
    }

    if (state.token) {
      if (elements.authBtnLabel) elements.authBtnLabel.innerText = 'Connected';
      if (elements.authSettingsBtn) elements.authSettingsBtn.title = 'Hugging Face Access Token (Connected)';
      loadRepository(false); // Uses 1-hour cache if valid
    } else {
      if (elements.authBtnLabel) elements.authBtnLabel.innerText = 'Token';
      if (elements.authSettingsBtn) elements.authSettingsBtn.title = 'Configure Hugging Face Token';
      showAuthModal();
    }
  }

  init();
})();
