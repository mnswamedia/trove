/**
 * Trove Media Vault - Utility Functions & Motion Suite
 * Shared helpers, formatters, animations, and IndexedDB blob persistence.
 */
(function() {
  window.Trove = window.Trove || {};

  const CONFIG = window.APP_CONFIG || {};
  const extensions = CONFIG.extensions || {};
  const storage = CONFIG.storage || {};

  const MUSIC_EXTENSIONS = new Set(extensions.music || ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus']);
  const VIDEO_EXTENSIONS = new Set(extensions.video || ['mp4', 'mkv', 'webm', 'avi', 'mov', 'flv', 'wmv', 'm4v']);
  const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico']);
  const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'csv', 'yaml', 'yml', 'xml', 'log']);

  // Classify File Type by Extension
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

  // Format File Size
  function formatBytes(bytes) {
    if (!bytes || isNaN(bytes) || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // Format Seconds into mm:ss
  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  // Format Duration string or seconds
  function formatDuration(sec) {
    if (!sec || isNaN(sec)) return '--:--';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
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

  // YouTube URL Cleaner (Strips playlists, tracking tokens, radio stations)
  function cleanYouTubeUrl(urlStr) {
    if (!urlStr) return '';
    const trimmed = urlStr.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
        return `https://www.youtube.com/watch?v=${trimmed}`;
      }
      return trimmed;
    }

    try {
      const u = new URL(trimmed);
      const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');

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

  function extractYouTubeId(url) {
    if (!url) return null;
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/);
    return match ? match[1] : null;
  }

  // Toast Notification
  let toastTimer = null;
  function showToast(message, duration = 3000) {
    let toast = document.getElementById('trove-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'trove-toast';
      toast.className = 'fixed bottom-24 sm:bottom-20 left-1/2 -translate-x-1/2 z-[130] px-4 py-2 bg-jet-black/95 dark:bg-[#1e222c]/95 border border-khaki-beige dark:border-[#353c4d] text-white dark:text-[#f3f4f6] text-xs font-semibold rounded-full shadow-2xl transition-all duration-300 pointer-events-none opacity-0 translate-y-3 select-none flex items-center gap-2';
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span><span>${escapeHtml(message)}</span>`;
    toast.classList.remove('opacity-0', 'translate-y-3');
    toast.classList.add('opacity-100', 'translate-y-0');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('opacity-100', 'translate-y-0');
      toast.classList.add('opacity-0', 'translate-y-3');
    }, duration);
  }

  // Exit Toast Display Helper
  let exitToastTimeout = null;
  function showExitToast(message = 'Press back again to exit') {
    const toast = document.getElementById('trove-exit-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.remove('opacity-0', 'translate-y-3');
    toast.classList.add('opacity-100', 'translate-y-0');

    if (exitToastTimeout) clearTimeout(exitToastTimeout);
    exitToastTimeout = setTimeout(() => {
      toast.classList.remove('opacity-100', 'translate-y-0');
      toast.classList.add('opacity-0', 'translate-y-3');
    }, 2000);
  }

  // =========================================================================
  // MOTION ANIMATION SUITE (Cubic-Bezier Springs & Micro-Interactions)
  // =========================================================================
  const MotionAnim = {
    isAvailable() {
      return typeof window.Motion !== 'undefined' && typeof window.Motion.animate === 'function';
    },

    // 1. App Launch Intro
    playAppIntro() {
      if (!this.isAvailable()) return;
      try {
        const { animate } = window.Motion;
        const header = document.querySelector('header');
        if (header) {
          animate(header, { transform: ['translateY(-16px)', 'translateY(0px)'], opacity: [0, 1] }, { duration: 0.38, easing: [0.22, 1, 0.36, 1] });
        }
        const controls = document.querySelector('main > div:first-child');
        if (controls) {
          animate(controls, { transform: ['translateY(-8px)', 'translateY(0px)'], opacity: [0, 1] }, { duration: 0.35, delay: 0.08, easing: 'ease-out' });
        }
        const fileContainer = document.getElementById('file-list')?.parentElement;
        if (fileContainer) {
          animate(fileContainer, { transform: ['translateY(12px)', 'translateY(0px)'], opacity: [0, 1] }, { duration: 0.4, delay: 0.12, easing: [0.22, 1, 0.36, 1] });
        }
      } catch (err) {
        console.warn('App intro animation warning:', err);
      }
    },

    // 2. File list rows subtle stagger entrance
    animateFileList(container) {
      const fileListEl = container || document.getElementById('file-list');
      if (!this.isAvailable() || !fileListEl) return;
      try {
        const { animate } = window.Motion;
        const stagger = window.Motion.stagger || ((val) => (i) => i * val);
        const rows = fileListEl.querySelectorAll('.file-row');
        if (!rows || rows.length === 0) return;

        const visibleSlice = Array.from(rows).slice(0, 30);
        animate(
          visibleSlice,
          { transform: ['translateY(8px)', 'translateY(0px)'], opacity: [0, 1] },
          { delay: stagger(0.016), duration: 0.22, easing: 'ease-out' }
        );
      } catch (err) {
        console.warn('File list animation warning:', err);
      }
    },

    // 3. Tactile micro-pop
    pulseButton(btn) {
      if (!this.isAvailable() || !btn) return;
      try {
        const { animate } = window.Motion;
        animate(btn, { transform: ['scale(0.88)', 'scale(1.08)', 'scale(1)'] }, { duration: 0.24, easing: 'ease-out' });
      } catch (_) {}
    },

    // 4. Bottom Play Bar Spring Slide-In
    animateBottomBar(barEl) {
      const el = barEl || document.getElementById('bottom-play-bar');
      if (!this.isAvailable() || !el) return;
      try {
        const { animate } = window.Motion;
        animate(
          el,
          { transform: ['translateY(60px)', 'translateY(0px)'], opacity: [0, 1] },
          { duration: 0.38, easing: [0.32, 0.72, 0, 1] }
        );
      } catch (_) {}
    },

    // 5. Fullscreen / Expanded Player Sheet Opening
    animateExpandedOpen(playerEl, coverArtEl) {
      const el = playerEl || document.getElementById('expanded-player');
      const art = coverArtEl || document.getElementById('expanded-cover-art');
      if (!this.isAvailable() || !el) return;
      try {
        const { animate } = window.Motion;
        animate(
          el,
          { transform: ['translateY(100%)', 'translateY(0%)'] },
          { duration: 0.36, easing: [0.32, 0.72, 0, 1] }
        );
        if (art) {
          animate(
            art,
            { transform: ['scale(0.93)', 'scale(1)'], opacity: [0.7, 1] },
            { duration: 0.35, delay: 0.08, easing: 'ease-out' }
          );
        }
      } catch (_) {}
    },

    // 6. Fullscreen / Expanded Player Sheet Closing
    animateExpandedClose(playerEl, onDone) {
      const el = playerEl || document.getElementById('expanded-player');
      if (!this.isAvailable() || !el) {
        if (onDone) onDone();
        return;
      }
      try {
        const { animate } = window.Motion;
        const anim = animate(
          el,
          { transform: ['translateY(0%)', 'translateY(100%)'] },
          { duration: 0.24, easing: [0.32, 0.72, 0, 1] }
        );
        if (anim && anim.finished) {
          anim.finished.then(() => { if (onDone) onDone(); }).catch(() => { if (onDone) onDone(); });
        } else {
          setTimeout(() => { if (onDone) onDone(); }, 250);
        }
      } catch (_) {
        if (onDone) onDone();
      }
    },

    // 7. Track Artwork Crossfade
    animateTrackArt() {
      if (!this.isAvailable()) return;
      try {
        const { animate } = window.Motion;
        const expandedImg = document.getElementById('expanded-cover-img');
        const barImg = document.getElementById('bar-thumb-img');
        if (expandedImg && !expandedImg.classList.contains('hidden')) {
          animate(expandedImg, { transform: ['scale(0.95)', 'scale(1)'], opacity: [0.7, 1] }, { duration: 0.28, easing: 'ease-out' });
        }
        if (barImg && !barImg.classList.contains('hidden')) {
          animate(barImg, { transform: ['scale(0.9)', 'scale(1)'], opacity: [0.7, 1] }, { duration: 0.22, easing: 'ease-out' });
        }
      } catch (_) {}
    },

    // 8. Modal Entrance
    animateModalIn(modalEl) {
      if (!this.isAvailable() || !modalEl) return;
      try {
        const { animate } = window.Motion;
        const card = modalEl.firstElementChild;
        animate(modalEl, { opacity: [0, 1] }, { duration: 0.18, easing: 'ease-out' });
        if (card) {
          animate(card, { transform: ['scale(0.94) translateY(12px)', 'scale(1) translateY(0px)'] }, { duration: 0.26, easing: [0.22, 1, 0.36, 1] });
        }
      } catch (_) {}
    },

    // 9. Modal Exit
    animateModalOut(modalEl, onDone) {
      if (!this.isAvailable() || !modalEl) {
        if (onDone) onDone();
        return;
      }
      try {
        const { animate } = window.Motion;
        const card = modalEl.firstElementChild;
        if (card) {
          animate(card, { transform: ['scale(1) translateY(0px)', 'scale(0.95) translateY(8px)'] }, { duration: 0.14, easing: 'ease-in' });
        }
        const anim = animate(modalEl, { opacity: [1, 0] }, { duration: 0.15, easing: 'ease-in' });
        if (anim && anim.finished) {
          anim.finished.then(() => { if (onDone) onDone(); }).catch(() => { if (onDone) onDone(); });
        } else {
          setTimeout(() => { if (onDone) onDone(); }, 160);
        }
      } catch (_) {
        if (onDone) onDone();
      }
    },

    // 10. Bottom Sheet Entrance
    animateSheetIn(sheetEl) {
      if (!this.isAvailable() || !sheetEl) return;
      try {
        const { animate } = window.Motion;
        const card = sheetEl.querySelector('.relative') || sheetEl.firstElementChild;
        animate(sheetEl, { opacity: [0, 1] }, { duration: 0.16, easing: 'ease-out' });
        if (card) {
          animate(card, { transform: ['translateY(100%)', 'translateY(0%)'] }, { duration: 0.28, easing: [0.32, 0.72, 0, 1] });
        }
      } catch (_) {}
    },

    // 11. Bottom Sheet Exit
    animateSheetOut(sheetEl, onDone) {
      if (!this.isAvailable() || !sheetEl) {
        if (onDone) onDone();
        return;
      }
      try {
        const { animate } = window.Motion;
        const card = sheetEl.querySelector('.relative') || sheetEl.firstElementChild;
        if (card) {
          animate(card, { transform: ['translateY(0%)', 'translateY(100%)'] }, { duration: 0.2, easing: [0.32, 0.72, 0, 1] });
        }
        const anim = animate(sheetEl, { opacity: [1, 0] }, { duration: 0.18, easing: 'ease-in' });
        if (anim && anim.finished) {
          anim.finished.then(() => { if (onDone) onDone(); }).catch(() => { if (onDone) onDone(); });
        } else {
          setTimeout(() => { if (onDone) onDone(); }, 200);
        }
      } catch (_) {
        if (onDone) onDone();
      }
    },

    // 12. Top Drawer Entrance
    animateTopDrawerIn(drawerEl) {
      if (!this.isAvailable() || !drawerEl) return;
      try {
        const { animate } = window.Motion;
        const card = drawerEl.querySelector('.relative') || drawerEl.firstElementChild;
        animate(drawerEl, { opacity: [0, 1] }, { duration: 0.16, easing: 'ease-out' });
        if (card) {
          animate(card, { transform: ['translateY(-100%)', 'translateY(0%)'] }, { duration: 0.28, easing: [0.32, 0.72, 0, 1] });
        }
      } catch (_) {}
    },

    // 13. Top Drawer Exit
    animateTopDrawerOut(drawerEl, onDone) {
      if (!this.isAvailable() || !drawerEl) {
        if (onDone) onDone();
        return;
      }
      try {
        const { animate } = window.Motion;
        const card = drawerEl.querySelector('.relative') || drawerEl.firstElementChild;
        if (card) {
          animate(card, { transform: ['translateY(0%)', 'translateY(-100%)'] }, { duration: 0.2, easing: [0.32, 0.72, 0, 1] });
        }
        const anim = animate(drawerEl, { opacity: [1, 0] }, { duration: 0.18, easing: 'ease-in' });
        if (anim && anim.finished) {
          anim.finished.then(() => { if (onDone) onDone(); }).catch(() => { if (onDone) onDone(); });
        } else {
          setTimeout(() => { if (onDone) onDone(); }, 200);
        }
      } catch (_) {
        if (onDone) onDone();
      }
    }
  };

  // =========================================================================
  // PERSISTENT INDEXEDDB STORAGE (Media Blobs & Original-Quality Thumbnails)
  // =========================================================================
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

  async function saveThumbnailBlobToIDB(path, blob) {
    try {
      const db = await getIDB();
      if (!db) return;
      const tx = db.transaction(IDB_STORE_THUMBS, 'readwrite');
      const store = tx.objectStore(IDB_STORE_THUMBS);
      store.put({ path, blob, cachedAt: Date.now() });

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

  async function saveMediaToIDB(path, blob) {
    try {
      const db = await getIDB();
      if (!db) return;
      const tx = db.transaction(IDB_STORE_MEDIA, 'readwrite');
      const store = tx.objectStore(IDB_STORE_MEDIA);
      store.put({ path, blob, cachedAt: Date.now() });

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

  // Export to Trove namespace
  window.Trove.utils = {
    getFileInfo,
    formatBytes,
    formatTime,
    formatDuration,
    escapeHtml,
    cleanYouTubeUrl,
    cleanAllInputUrls,
    extractYouTubeId,
    showToast,
    showExitToast,
    MotionAnim,
    getIDB,
    saveThumbnailBlobToIDB,
    getThumbnailBlobFromIDB,
    saveMediaToIDB,
    getMediaFromIDB
  };

  // Backwards compatibility alias
  window.MotionAnim = MotionAnim;
})();

