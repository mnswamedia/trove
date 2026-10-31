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
    owner: 'mnswa',
    repo: 'trove',
    workflowFile: 'ingest.yml',
    ref: 'main'
  },
  storage: {
    tokenKey: 'trove_hf_token',
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
    maxMediaBlobs: 10
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
