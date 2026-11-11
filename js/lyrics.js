/**
 * Trove Media Vault - Lyrics Module
 * On-demand lyrics fetching from Cloudflare Worker (YouTube Music + LRCLIB fallback).
 * Never pre-fetches; only loads when the user explicitly requests the Lyrics tab.
 */
(function() {
  window.Trove = window.Trove || {};

  const CONFIG = window.APP_CONFIG || {};
  const storage = CONFIG.storage || {};
  const { showToast } = window.Trove.utils || {};

  const LyricsManager = {
    activeTab: 'cover', // 'cover' | 'lyrics'
    currentTrackPath: null,
    cache: new Map(), // trackPath -> { lyrics, plainLyrics, syncedLyrics, source, trackName, artistName }
    isLoading: false,
    elements: {},

    init() {
      this.elements = {
        tabSwitcher: document.getElementById('player-tab-switcher'),
        tabBtnCover: document.getElementById('tab-btn-cover'),
        tabBtnLyrics: document.getElementById('tab-btn-lyrics'),
        coverContainer: document.getElementById('expanded-cover-art'),
        lyricsContainer: document.getElementById('expanded-lyrics-container'),
        lyricsSourceBadge: document.getElementById('lyrics-source-badge'),
        lyricsScrollBody: document.getElementById('lyrics-scroll-body'),
        lyricsLoading: document.getElementById('lyrics-loading'),
        lyricsEmpty: document.getElementById('lyrics-empty'),
        lyricsEmptyMessage: document.getElementById('lyrics-empty-message'),
        lyricsContent: document.getElementById('lyrics-content'),
        btnCopyLyrics: document.getElementById('btn-copy-lyrics'),
        btnRefreshLyrics: document.getElementById('btn-refresh-lyrics'),
        btnRetryLyrics: document.getElementById('btn-retry-lyrics')
      };

      this.setupEventListeners();
    },

    setupEventListeners() {
      if (this.elements.tabBtnCover) {
        this.elements.tabBtnCover.addEventListener('click', (e) => {
          e.stopPropagation();
          this.switchTab('cover');
        });
      }

      if (this.elements.tabBtnLyrics) {
        this.elements.tabBtnLyrics.addEventListener('click', (e) => {
          e.stopPropagation();
          this.switchTab('lyrics');
        });
      }

      if (this.elements.btnRefreshLyrics) {
        this.elements.btnRefreshLyrics.addEventListener('click', (e) => {
          e.stopPropagation();
          this.fetchLyrics(true);
        });
      }

      if (this.elements.btnRetryLyrics) {
        this.elements.btnRetryLyrics.addEventListener('click', (e) => {
          e.stopPropagation();
          this.fetchLyrics(true);
        });
      }

      if (this.elements.btnCopyLyrics) {
        this.elements.btnCopyLyrics.addEventListener('click', (e) => {
          e.stopPropagation();
          this.copyLyrics();
        });
      }
    },

    switchTab(tab) {
      this.activeTab = tab;
      this.updateTabUI();

      if (tab === 'lyrics') {
        const player = window.Trove.player;
        const currentTrack = player ? player.currentTrack : null;

        if (!currentTrack) {
          this.renderEmpty('No Track Playing', 'Play an audio track to view lyrics.');
          return;
        }

        // On-demand: check if cached, else fetch
        if (this.currentTrackPath !== currentTrack.path || !this.cache.has(currentTrack.path)) {
          this.fetchLyrics(false);
        } else {
          this.renderLyrics(this.cache.get(currentTrack.path));
        }
      }
    },

    updateTabUI() {
      const isLyrics = this.activeTab === 'lyrics';

      if (this.elements.tabBtnCover) {
        if (isLyrics) {
          this.elements.tabBtnCover.className = 'px-3 py-1 rounded-lg text-xs font-medium transition text-stone-brown dark:text-[#9aa4b2] hover:text-black dark:hover:text-white flex items-center gap-1.5';
        } else {
          this.elements.tabBtnCover.className = 'px-3 py-1 rounded-lg text-xs font-semibold transition bg-white dark:bg-[#252b38] text-jet-black dark:text-[#f3f4f6] shadow-sm flex items-center gap-1.5';
        }
      }

      if (this.elements.tabBtnLyrics) {
        if (isLyrics) {
          this.elements.tabBtnLyrics.className = 'px-3 py-1 rounded-lg text-xs font-semibold transition bg-white dark:bg-[#252b38] text-jet-black dark:text-[#f3f4f6] shadow-sm flex items-center gap-1.5';
        } else {
          this.elements.tabBtnLyrics.className = 'px-3 py-1 rounded-lg text-xs font-medium transition text-stone-brown dark:text-[#9aa4b2] hover:text-black dark:hover:text-white flex items-center gap-1.5';
        }
      }

      if (this.elements.coverContainer) {
        if (isLyrics) {
          this.elements.coverContainer.classList.add('hidden');
        } else {
          this.elements.coverContainer.classList.remove('hidden');
        }
      }

      if (this.elements.lyricsContainer) {
        if (isLyrics) {
          this.elements.lyricsContainer.classList.remove('hidden');
        } else {
          this.elements.lyricsContainer.classList.add('hidden');
        }
      }

      if (window.lucide) {
        window.lucide.createIcons();
      }
    },

    onTrackChanged(newTrack) {
      // ONLY load lyrics if the user currently has the Lyrics tab active.
      // If on the Cover tab, do NOT pre-fetch anything!
      if (this.activeTab === 'lyrics' && newTrack) {
        if (this.currentTrackPath !== newTrack.path) {
          this.fetchLyrics(false);
        }
      }
    },

    async fetchLyrics(forceRefresh = false) {
      const player = window.Trove.player;
      const track = player ? player.currentTrack : null;

      if (!track) {
        this.renderEmpty('No Track Playing', 'Play an audio track to view lyrics.');
        return;
      }

      this.currentTrackPath = track.path;

      // 1. In-memory Cache Check
      if (!forceRefresh && this.cache.has(track.path)) {
        this.renderLyrics(this.cache.get(track.path));
        return;
      }

      this.setLoading(true);

      try {
        // 2. Offline IndexedDB Cache Check
        if (!forceRefresh && window.Trove.utils?.getLyricsFromIDB) {
          const idbLyrics = await window.Trove.utils.getLyricsFromIDB(track.path);
          if (idbLyrics && idbLyrics.lyrics) {
            this.cache.set(track.path, idbLyrics);
            this.renderLyrics(idbLyrics);
            this.setLoading(false);
            return;
          }
        }

        // Clean song name for search & filename
        const cleanName = track.name
          .replace(/\.[a-zA-Z0-9]+$/, '')
          .replace(/\[[A-Za-z0-9_-]{11}\]/g, '')
          .trim();

        let trackTitle = cleanName;
        let artistName = null;

        if (cleanName.includes(' - ')) {
          const parts = cleanName.split(' - ');
          artistName = parts[0].trim();
          trackTitle = parts.slice(1).join(' - ').trim();
        }

        const baseName = track.name
          ? track.name.replace(/\.[a-zA-Z0-9]+$/, '').trim()
          : track.path.split('/').pop().replace(/\.[a-zA-Z0-9]+$/, '').trim();
        const safeLyricsFileName = `${baseName.replace(/[^\w\s\-\.\(\)]/gi, '_').trim()}.json`;

        const state = window.Trove.state || {};
        const repo = state.repo || CONFIG.repo;

        // 3. Direct Hugging Face Dataset Check (check HF from UI directly)
        if (!forceRefresh && repo && repo.id) {
          try {
            const hfRawUrl = `https://huggingface.co/datasets/${repo.id}/raw/${repo.branch || 'main'}/lyrics/${encodeURIComponent(safeLyricsFileName)}`;
            const hfHeaders = state.token ? { 'Authorization': `Bearer ${state.token}` } : {};
            const hfRes = await fetch(hfRawUrl, { headers: hfHeaders });
            if (hfRes.ok) {
              const hfJson = await hfRes.json();
              if (hfJson && hfJson.lyrics) {
                hfJson.source = hfJson.source ? `${hfJson.source} (HF)` : 'Hugging Face';
                this.cache.set(track.path, hfJson);
                if (window.Trove.utils?.saveLyricsToIDB) {
                  await window.Trove.utils.saveLyricsToIDB(track.path, hfJson);
                }
                this.renderLyrics(hfJson);
                this.setLoading(false);
                return;
              }
            }
          } catch (hfErr) {
            console.warn('Direct HF lyrics check note:', hfErr);
          }
        }

        // 4. Resolve YouTube videoId if available
        let videoId = null;
        if (window.Trove.recommendations && typeof window.Trove.recommendations.resolveVideoId === 'function') {
          videoId = await window.Trove.recommendations.resolveVideoId(track);
        }

        // 5. Cloudflare Worker API request
        const workerUrl =
          (CONFIG.getWorkerEndpoint ? CONFIG.getWorkerEndpoint('/lyrics') : null) ||
          localStorage.getItem(storage.workerLyricsUrlKey) ||
          localStorage.getItem(storage.workerBaseUrlKey) ||
          '';
        const workerToken = CONFIG.getWorkerToken ? CONFIG.getWorkerToken() : (localStorage.getItem(storage.workerTokenKey) || '').trim();

        let lyricsData = null;

        if (workerUrl && workerToken) {
          try {
            const normalizedUrl = workerUrl.replace(/\/+$/, '');
            const lyricsEndpoint = /\/lyrics$/i.test(normalizedUrl) ? normalizedUrl : `${normalizedUrl}/lyrics`;
            const u = new URL(lyricsEndpoint);
            if (videoId) {
              u.searchParams.set('videoId', videoId);
            }
            if (trackTitle) u.searchParams.set('title', trackTitle);
            if (artistName) u.searchParams.set('artist', artistName);
            if (forceRefresh) u.searchParams.set('fresh', '1');

            const headers = CONFIG.getWorkerAuthHeaders
              ? CONFIG.getWorkerAuthHeaders({ 'Accept': 'application/json' })
              : {
                  'Accept': 'application/json',
                  'Authorization': `Bearer ${workerToken}`,
                  'X-API-Key': workerToken
                };

            const res = await fetch(u.toString(), {
              headers,
              cache: forceRefresh ? 'no-store' : 'default'
            });
            if (res.ok) {
              this._authWarned = false;
              const json = await res.json();
              if (json && json.success && json.lyrics) {
                lyricsData = json;
              }
            } else if ((res.status === 401 || res.status === 503) && !this._authWarned) {
              this._authWarned = true;
              console.warn(`Lyrics Worker auth failed (${res.status}); falling back to LRCLIB.`);
              if (showToast) showToast('Worker Lyrics auth failed — check API Secret in Settings');
            }
          } catch (workerErr) {
            console.warn('Lyrics Worker fetch note:', workerErr);
          }
        } else if (workerUrl && !workerToken && !this._authWarned) {
          this._authWarned = true;
          console.warn('Cloudflare Worker URL set without API Secret; skipping Worker for lyrics.');
        }

        // 6. Zero-config direct LRCLIB fallback if worker is unset or returned no lyrics
        if (!lyricsData) {
          try {
            const query = [trackTitle, artistName].filter(Boolean).join(' ');
            const lrclibUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
            const lRes = await fetch(lrclibUrl, {
              headers: { 'User-Agent': 'Trove-Media-Vault/1.0 (https://github.com/mnswa/trove)' }
            });

            if (lRes.ok) {
              const list = await lRes.json();
              if (Array.isArray(list) && list.length > 0) {
                const match = list.find((x) => x.plainLyrics || x.syncedLyrics) || list[0];
                if (match && (match.plainLyrics || match.syncedLyrics)) {
                  const plain =
                    match.plainLyrics ||
                    match.syncedLyrics.replace(/\[\d{2}:\d{2}(?:\.\d{1,3})?\]\s*/g, '').trim();
                  lyricsData = {
                    success: true,
                    lyrics: plain,
                    plainLyrics: plain,
                    syncedLyrics: match.syncedLyrics || null,
                    source: 'LRCLIB',
                    trackName: match.trackName || trackTitle,
                    artistName: match.artistName || artistName
                  };
                }
              }
            }
          } catch (_) {}
        }

        if (lyricsData && lyricsData.lyrics) {
          this.cache.set(track.path, lyricsData);
          if (window.Trove.utils?.saveLyricsToIDB) {
            window.Trove.utils.saveLyricsToIDB(track.path, lyricsData);
          }

          // Asynchronously commit to Hugging Face dataset under lyrics/ folder
          if (state.token && repo && repo.id) {
            this.commitLyricsToHF(repo, state.token, safeLyricsFileName, lyricsData, cleanName);
          }

          this.renderLyrics(lyricsData);
        } else {
          this.renderEmpty(
            'Lyrics Not Found',
            `Couldn't locate lyrics for "${cleanName}".`
          );
        }
      } catch (err) {
        console.error('Lyrics error:', err);
        this.renderEmpty(
          'Failed to Load Lyrics',
          'Network error or lyrics unavailable. Tap retry to try again.'
        );
      } finally {
        this.setLoading(false);
      }
    },

    async commitLyricsToHF(repo, token, fileName, lyricsData, trackTitle) {
      if (!repo || !token || !fileName || !lyricsData) return;
      const repoId = (
        (CONFIG.storage?.hfRepoKey && localStorage.getItem(CONFIG.storage.hfRepoKey)) ||
        repo.id ||
        'mnswa/trove_dataset'
      ).trim();
      if (!repoId) return;

      try {
        const jsonStr = JSON.stringify(lyricsData, null, 2);
        let encodedContent;
        try {
          const bytes = new TextEncoder().encode(jsonStr);
          let binary = '';
          for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          encodedContent = btoa(binary);
        } catch (_) {
          encodedContent = btoa(unescape(encodeURIComponent(jsonStr)));
        }

        const filePath = `lyrics/${fileName}`;

        const headerLine = JSON.stringify({
          key: 'header',
          value: {
            summary: `Save lyrics for "${trackTitle || fileName}"`,
            description: ''
          }
        });
        const fileLine = JSON.stringify({
          key: 'file',
          value: {
            path: filePath,
            content: encodedContent,
            encoding: 'base64'
          }
        });
        const ndjsonBody = `${headerLine}\n${fileLine}\n`;

        const branch = repo.branch || 'main';
        const candidateEndpoints = [
          `https://huggingface.co/api/datasets/${repoId}/commit/${encodeURIComponent(branch)}`,
          `https://huggingface.co/api/datasets/${repoId}/commit/main`,
          `https://huggingface.co/api/datasets/${repoId}/commit/master`,
          `https://huggingface.co/api/models/${repoId}/commit/${encodeURIComponent(branch)}`
        ].filter((u, idx, arr) => arr.indexOf(u) === idx);

        for (const commitUrl of candidateEndpoints) {
          try {
            const res = await fetch(commitUrl, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/x-ndjson'
              },
              body: ndjsonBody
            });

            if (res.ok) {
              console.log(`Lyrics for "${trackTitle}" stored in HF dataset (${filePath})`);
              return;
            }
          } catch (_) {}
        }
      } catch (err) {
        console.warn('Asynchronous HF lyrics upload note:', err);
      }
    },

    setLoading(loading) {
      this.isLoading = loading;
      if (this.elements.lyricsLoading) {
        if (loading) {
          this.elements.lyricsLoading.classList.remove('hidden');
          if (this.elements.lyricsContent) this.elements.lyricsContent.classList.add('hidden');
          if (this.elements.lyricsEmpty) this.elements.lyricsEmpty.classList.add('hidden');
        } else {
          this.elements.lyricsLoading.classList.add('hidden');
        }
      }

      if (this.elements.btnRefreshLyrics) {
        this.elements.btnRefreshLyrics.disabled = loading;
        const icon = this.elements.btnRefreshLyrics.querySelector('i, svg');
        if (icon) {
          icon.classList.toggle('animate-spin', loading);
        }
      }

      if (this.elements.btnRetryLyrics) {
        this.elements.btnRetryLyrics.disabled = loading;
        if (loading) {
          this.elements.btnRetryLyrics.innerHTML = '<span class="inline-flex items-center gap-1.5"><i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i><span>Retrying...</span></span>';
          if (window.lucide) window.lucide.createIcons();
        } else {
          this.elements.btnRetryLyrics.innerText = 'Retry';
        }
      }
    },

    renderLyrics(data) {
      if (!this.elements.lyricsContent) return;

      if (this.elements.lyricsEmpty) this.elements.lyricsEmpty.classList.add('hidden');
      if (this.elements.lyricsLoading) this.elements.lyricsLoading.classList.add('hidden');

      if (this.elements.lyricsSourceBadge) {
        this.elements.lyricsSourceBadge.innerText = data.source ? `Source: ${data.source}` : 'Lyrics';
      }

      this.elements.lyricsContent.innerText = data.lyrics || data.plainLyrics || '';
      this.elements.lyricsContent.classList.remove('hidden');

      if (this.elements.lyricsScrollBody) {
        this.elements.lyricsScrollBody.scrollTop = 0;
      }
    },

    renderEmpty(title, message) {
      if (this.elements.lyricsContent) this.elements.lyricsContent.classList.add('hidden');
      if (this.elements.lyricsLoading) this.elements.lyricsLoading.classList.add('hidden');

      if (this.elements.lyricsEmpty) {
        this.elements.lyricsEmpty.classList.remove('hidden');
        if (this.elements.lyricsEmptyMessage) {
          this.elements.lyricsEmptyMessage.innerText = message || title;
        }
      }

      if (this.elements.lyricsSourceBadge) {
        this.elements.lyricsSourceBadge.innerText = 'Lyrics';
      }
    },

    copyLyrics() {
      const text = this.elements.lyricsContent?.innerText || '';
      if (!text) {
        if (showToast) showToast('No lyrics available to copy');
        return;
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          if (showToast) showToast('Lyrics copied to clipboard!');
        }).catch(() => {
          if (showToast) showToast('Could not copy lyrics');
        });
      }
    }
  };

  // Export
  window.Trove.lyrics = LyricsManager;
})();

