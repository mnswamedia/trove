/**
 * Trove Application Configuration
 * All dynamic parameters, bucket/dataset paths, extensions, and storage keys are defined here.
 */
window.APP_CONFIG = {
  repo: {
    id: 'mnswa/trove_dataset',
    owner: 'mnswa',
    name: 'trove_dataset',
    isBucket: true, // true for Hugging Face Storage Buckets (huggingface.co/buckets/...)
    isPrivate: true
  },
  github: {
    owner: 'mnswamedia',
    repo: 'trove',
    workflowFile: 'ingest.yml',
    ref: 'main'
  },
  storage: {
    tokenKey: 'trove_hf_token',
    hfRepoKey: 'trove_hf_repo',
    ghTokenKey: 'trove_gh_token',
    ghRepoKey: 'trove_gh_repo',
    fsCacheKey: 'trove_fs_cache',
    fsCacheTTL: 60 * 60 * 1000, // 1 hour in ms
    playbackStateKey: 'trove_playback_state',
    recentTracksKey: 'trove_recent_tracks',
    maxRecentTracks: 10,
    thumbnailsKey: 'trove_thumbnails_cache',
    maxCachedThumbnails: 25,
    viewSettingsKey: 'trove_view_settings',
    maxMediaBlobs: 10,
    workerBaseUrlKey: 'trove_worker_base_url',
    workerRecsUrlKey: 'trove_worker_recs_url',
    workerLyricsUrlKey: 'trove_worker_lyrics_url',
    workerPlaylistsUrlKey: 'trove_worker_playlists_url',
    workerMetricsUrlKey: 'trove_worker_metrics_url',
    playlistsCacheKey: 'trove_playlists_cache',
    workerTokenKey: 'trove_worker_token'
  },
  getWorkerEndpoint(subpath = '') {
    const s = this.storage || {};
    let baseUrl = (localStorage.getItem(s.workerBaseUrlKey) || '').trim().replace(/\/+$/, '');
    if (baseUrl) {
      baseUrl = baseUrl.replace(/\/(?:lyrics|playlists|metrics|recommendations|recs)$/i, '');
      const cleanSub = subpath ? (subpath.startsWith('/') ? subpath : '/' + subpath) : '';
      return `${baseUrl}${cleanSub}`;
    }

    // Backward-compatible fallback to legacy individual worker URLs
    const cleanSub = (subpath ? (subpath.startsWith('/') ? subpath : '/' + subpath) : '').toLowerCase();
    if (cleanSub.includes('lyrics')) {
      const u = (localStorage.getItem(s.workerLyricsUrlKey) || '').trim().replace(/\/+$/, '');
      if (u) return u.endsWith('/lyrics') ? u : `${u}/lyrics`;
    }
    if (cleanSub.includes('playlists')) {
      const u = (localStorage.getItem(s.workerPlaylistsUrlKey) || '').trim().replace(/\/+$/, '');
      if (u) return u.endsWith('/playlists') ? u : `${u}/playlists`;
    }
    if (cleanSub.includes('metrics')) {
      const u = (localStorage.getItem(s.workerMetricsUrlKey) || '').trim().replace(/\/+$/, '');
      if (u) return u.endsWith(cleanSub) ? u : `${u}${cleanSub}`;
    }
    if (cleanSub.includes('recommendations') || cleanSub.includes('recs') || cleanSub.includes('extract')) {
      const u = (localStorage.getItem(s.workerRecsUrlKey) || '').trim().replace(/\/+$/, '');
      if (u) return u.endsWith('/recommendations') ? u : `${u}/recommendations`;
    }
    return null;
  },
  api: {
    bucketsBase: 'https://huggingface.co/api/buckets',
    datasetsBase: 'https://huggingface.co/api/datasets',
    s3Endpoint: 'https://s3.hf.co/mnswa'
  },
  extensions: {
    music: [
      'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'alac', 'aiff', 'mid', 'midi'
    ],
    video: [
      'mp4', 'mkv', 'webm', 'avi', 'mov', 'flv', 'wmv', 'm4v', 'ts', '3gp', 'ogv'
    ]
  }
};

// Initialize configured repositories from localStorage if present
try {
  const savedHfRepo = localStorage.getItem(window.APP_CONFIG.storage.hfRepoKey);
  if (savedHfRepo && savedHfRepo.trim()) {
    const cleanRepo = savedHfRepo.trim();
    window.APP_CONFIG.repo.id = cleanRepo;
    const parts = cleanRepo.split('/').map(s => s.trim());
    if (parts.length >= 2) {
      window.APP_CONFIG.repo.owner = parts[0];
      window.APP_CONFIG.repo.name = parts.slice(1).join('/');
    } else {
      window.APP_CONFIG.repo.name = cleanRepo;
    }
  }

  const savedGhRepo = localStorage.getItem(window.APP_CONFIG.storage.ghRepoKey);
  if (savedGhRepo && savedGhRepo.trim()) {
    const cleanGhRepo = savedGhRepo.trim();
    const ghParts = cleanGhRepo.split('/').map(s => s.trim());
    if (ghParts.length >= 2) {
      window.APP_CONFIG.github.owner = ghParts[0];
      window.APP_CONFIG.github.repo = ghParts.slice(1).join('/');
    }
  }
} catch (e) {
  console.warn('Could not initialize repo configs from localStorage:', e);
}

