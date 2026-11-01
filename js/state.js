/**
 * Trove Media Vault - Application State & LocalStorage Store
 * Centralized state and persistent preferences management.
 */
(function() {
  window.Trove = window.Trove || {};

  const CONFIG = window.APP_CONFIG || {};
  const repo = CONFIG.repo || {};
  const storage = CONFIG.storage || {};

  // Core Runtime State
  const state = {
    token: localStorage.getItem(storage.tokenKey) || null,
    allItems: [],
    currentDirectory: '',
    viewMode: 'tree', // 'tree' | 'flat'
    sortBy: 'name',   // 'name' | 'size' | 'time'
    sortOrder: 'asc', // 'asc' | 'desc'
    filterType: 'all', // 'all' | 'video' | 'music' | 'document' | 'image' | 'other'
    searchQuery: '',
    isLoading: false,
    error: null,
    pendingAutoPlayId: null,
    pendingAutoPlayTitle: null
  };

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
  function getFsCacheKey() {
    return `${storage.fsCacheKey || 'trove_fs_cache'}_${repo.id || 'default'}`;
  }
  const FS_CACHE_TTL = storage.fsCacheTTL || (60 * 60 * 1000); // 1 hour in ms

  function getCachedFSTree() {
    try {
      const raw = localStorage.getItem(getFsCacheKey());
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
      localStorage.setItem(getFsCacheKey(), JSON.stringify({
        timestamp: Date.now(),
        items: items
      }));
    } catch (e) {
      console.warn('Could not write cached FS tree:', e);
    }
  }

  // 3. Recent Tracks History (Last 10 Played Items with LRU Rotation)
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

  // Export
  window.Trove.state = state;
  window.Trove.store = {
    loadSavedViewSettings,
    saveViewSettings,
    getCachedFSTree,
    setCachedFSTree,
    getRecentTracks,
    addRecentTrack,
    updateRecentTrackPosition
  };
})();

