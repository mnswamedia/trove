/**
 * Trove Media Vault - Media Player & Audio/Video Controller
 * Playback engine, queue, scrubber, lock screen MediaSession, and Expanded Sheet.
 */
(function() {
  window.Trove = window.Trove || {};

  const CONFIG = window.APP_CONFIG || {};
  const repo = CONFIG.repo || {};
  const api = CONFIG.api || {};
  const storage = CONFIG.storage || {};
  const MAX_MEDIA_CACHE = storage.maxMediaBlobs || 10;
  const PLAYBACK_STATE_KEY = storage.playbackStateKey || 'trove_playback_state';

  const {
    formatBytes,
    formatTime,
    MotionAnim,
    getThumbnailBlobFromIDB,
    saveThumbnailBlobToIDB,
    getMediaFromIDB,
    saveMediaToIDB
  } = window.Trove.utils || {};

  function updateVolumeUI(vol, isMuted = false) {
    const effectiveVol = isMuted ? 0 : vol;
    const pctText = isMuted ? 'Muted' : `${Math.round(vol * 100)}%`;

    const volumePercentageLabel = document.getElementById('volume-percentage-label');
    const volumePopoverPct = document.getElementById('volume-popover-pct');
    const volumeSlider = document.getElementById('volume-slider');
    const volumeIcon = document.getElementById('volume-icon');
    const popoverMuteIcon = document.getElementById('popover-mute-icon');

    if (volumePercentageLabel) volumePercentageLabel.innerText = pctText;
    if (volumePopoverPct) volumePopoverPct.innerText = pctText;
    if (volumeSlider) volumeSlider.value = effectiveVol;

    const iconName = isMuted || effectiveVol === 0 ? 'volume-x' : (effectiveVol < 0.5 ? 'volume-1' : 'volume-2');
    if (volumeIcon) volumeIcon.setAttribute('data-lucide', iconName);
    if (popoverMuteIcon) popoverMuteIcon.setAttribute('data-lucide', iconName);
    if (window.lucide) window.lucide.createIcons();
  }

  function captureVideoFrame(videoEl) {
    try {
      if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null;
      const canvas = document.createElement('canvas');
      const width = Math.min(videoEl.videoWidth, 640);
      const height = Math.round(width * (videoEl.videoHeight / videoEl.videoWidth));
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(videoEl, 0, 0, width, height);
      return canvas.toDataURL('image/jpeg', 0.85);
    } catch (e) {
      console.warn('Video frame capture failed:', e);
      return null;
    }
  }

  async function getSidecarThumbnail(item) {
    if (!item || !item.name) return null;
    const baseName = item.name.replace(/\.[a-zA-Z0-9]+$/, '');
    const encodedName = encodeURIComponent(baseName + '.json');
    const isBucket = repo.isBucket !== false;
    const state = window.Trove.state || {};

    const candidateUrls = isBucket ? [
      `https://huggingface.co/buckets/${repo.id}/resolve/metadata/${encodedName}`,
      `https://huggingface.co/buckets/${repo.id}/raw/metadata/${encodedName}`,
      `${api.bucketsBase}/${repo.id}/raw/metadata/${encodedName}`,
      `${api.bucketsBase}/${repo.id}/resolve/metadata/${encodedName}`,
      `https://huggingface.co/api/buckets/${repo.id}/raw/metadata/${encodedName}`
    ] : [
      `https://huggingface.co/datasets/${repo.id}/resolve/${repo.branch || 'main'}/metadata/${encodedName}`,
      `https://huggingface.co/datasets/${repo.id}/raw/${repo.branch || 'main'}/metadata/${encodedName}`,
      `${api.datasetsBase}/${repo.id}/resolve/${repo.branch || 'main'}/metadata/${encodedName}`
    ];

    for (const url of candidateUrls) {
      try {
        const headers = state.token ? { 'Authorization': `Bearer ${state.token}` } : {};
        const res = await fetch(url, { headers });
        if (res.ok) {
          const meta = await res.json();
          if (meta && meta.thumbnail && typeof meta.thumbnail === 'string') {
            return meta.thumbnail;
          }
        }
      } catch (_) {}
    }
    return null;
  }

  const Player = {
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
    volume: 1.0,
    savedStartTime: 0,
    blobCache: new Map(),
    thumbnailCache: new Map(),
    elements: {},

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
      if (!this.currentTrack) return this.elements.playerAudio;
      return this.currentTrack.category === 'video' ? this.elements.playerVideo : this.elements.playerAudio;
    },

    getInactiveElement() {
      if (!this.currentTrack) return this.elements.playerVideo;
      return this.currentTrack.category === 'video' ? this.elements.playerAudio : this.elements.playerVideo;
    },

    updateQueue(clickedItem = null) {
      const state = window.Trove.state || {};
      const playable = (state.allItems || []).filter(i => !i.isDir && (i.category === 'music' || i.category === 'video'));
      this.queue = playable;

      if (clickedItem) {
        this.currentIndex = this.queue.findIndex(i => i.path === clickedItem.path);
      }
      this.updateQueueCounter();
    },

    updateQueueCounter() {
      if (!this.elements.activeQueueCounter) return;
      if (this.queue.length === 0 || this.currentIndex < 0) {
        this.elements.activeQueueCounter.innerText = 'No media in queue';
      } else {
        this.elements.activeQueueCounter.innerText = `${this.currentIndex + 1} / ${this.queue.length} in queue`;
      }
    },

    async extractThumbnail(blob, item) {
      if (this.thumbnailCache.has(item.path)) {
        return this.thumbnailCache.get(item.path);
      }

      const idbBlob = await getThumbnailBlobFromIDB(item.path);
      if (idbBlob) {
        const thumbUrl = URL.createObjectURL(idbBlob);
        this.thumbnailCache.set(item.path, thumbUrl);
        return thumbUrl;
      }

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
              onError: () => resolve(null)
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

      try {
        const sidecarThumb = await getSidecarThumbnail(item);
        if (sidecarThumb) {
          this.thumbnailCache.set(item.path, sidecarThumb);
          return sidecarThumb;
        }
      } catch (e) {}

      return null;
    },

    updateThumbnailUI(thumbUrl, item) {
      const isVideo = item.category === 'video';

      if (thumbUrl) {
        if (this.elements.barThumbImg) {
          this.elements.barThumbImg.src = thumbUrl;
          this.elements.barThumbImg.classList.remove('hidden');
        }
        if (this.elements.barTypeIcon) this.elements.barTypeIcon.classList.add('hidden');
      } else {
        if (this.elements.barThumbImg) {
          this.elements.barThumbImg.removeAttribute('src');
          this.elements.barThumbImg.classList.add('hidden');
        }
        if (this.elements.barTypeIcon) {
          this.elements.barTypeIcon.classList.remove('hidden');
          this.elements.barTypeIcon.setAttribute('data-lucide', isVideo ? 'video' : 'music');
        }
      }

      if (thumbUrl && !isVideo) {
        if (this.elements.expandedCoverImg) {
          this.elements.expandedCoverImg.src = thumbUrl;
          this.elements.expandedCoverImg.classList.remove('hidden');
        }
        if (this.elements.expandedCoverFallback) this.elements.expandedCoverFallback.classList.add('hidden');
      } else {
        if (this.elements.expandedCoverImg) {
          this.elements.expandedCoverImg.removeAttribute('src');
          this.elements.expandedCoverImg.classList.add('hidden');
        }
        if (this.elements.expandedCoverFallback) this.elements.expandedCoverFallback.classList.remove('hidden');
        if (this.elements.expandedCoverIcon) this.elements.expandedCoverIcon.setAttribute('data-lucide', isVideo ? 'video' : 'music');
      }

      if (window.lucide) window.lucide.createIcons();

      if (thumbUrl && MotionAnim) {
        MotionAnim.animateTrackArt();
      }

      if (thumbUrl && this.currentTrack && item && this.currentTrack.path === item.path) {
        this.updateMediaSession(thumbUrl);
      }
    },

    async getMediaBlobAndUrl(item) {
      if (this.blobCache.has(item.path)) {
        return this.blobCache.get(item.path);
      }

      const cachedBlob = await getMediaFromIDB(item.path);
      if (cachedBlob) {
        const mimeType = item.category === 'music' ? 'audio/mpeg' : 'video/mp4';
        const typedBlob = cachedBlob.type ? cachedBlob : new Blob([cachedBlob], { type: mimeType });
        const blobUrl = URL.createObjectURL(typedBlob);
        const entry = { blob: typedBlob, url: blobUrl };
        this.setMediaCache(item.path, entry);
        return entry;
      }

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

      const state = window.Trove.state || {};
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
            saveMediaToIDB(item.path, typedBlob);
            return entry;
          }
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('Failed to load media file from bucket.');
    },

    async playTrack(item, startAtSeconds = 0) {
      if (!item || item.isDir) return;

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

      this.isPlaying = false;
      this.currentTrack = item;
      this.updateQueue(item);

      if (this.elements.barProgressSlider) this.elements.barProgressSlider.value = 0;
      if (this.elements.expandedProgressSlider) this.elements.expandedProgressSlider.value = 0;
      if (this.elements.barTimeCurrent) this.elements.barTimeCurrent.innerText = formatTime(startAtSeconds);
      if (this.elements.expandedTimeCurrent) this.elements.expandedTimeCurrent.innerText = formatTime(startAtSeconds);
      if (this.elements.barTimeDuration) this.elements.barTimeDuration.innerText = '--:--';
      if (this.elements.expandedTimeDuration) this.elements.expandedTimeDuration.innerText = '--:--';

      if (this.elements.barTrackTitle) this.elements.barTrackTitle.innerText = item.name;
      if (this.elements.barTrackExt) this.elements.barTrackExt.innerText = item.label || 'MEDIA';
      if (this.elements.expandedTrackTitle) this.elements.expandedTrackTitle.innerText = item.name;
      if (this.elements.expandedTrackMeta) {
        this.elements.expandedTrackMeta.innerText = `${item.label} • ${formatBytes(item.size)} • ${item.parentDir || 'Root'}`;
      }
      if (this.elements.expandedSubtitle) {
        this.elements.expandedSubtitle.innerText = `${repo.id} / ${item.parentDir || 'Vault'}`;
      }

      const cachedThumb = this.thumbnailCache.get(item.path) || null;
      this.updateThumbnailUI(cachedThumb, item);
      if (cachedThumb) {
        this.updateMediaSession(cachedThumb);
      }

      const isVideo = item.category === 'video';
      if (isVideo) {
        if (this.elements.stageVideo) this.elements.stageVideo.classList.remove('hidden');
        if (this.elements.stageMusic) this.elements.stageMusic.classList.add('hidden');
        if (this.elements.btnPipToggle) this.elements.btnPipToggle.classList.remove('hidden');
      } else {
        if (this.elements.stageVideo) this.elements.stageVideo.classList.add('hidden');
        if (this.elements.stageMusic) this.elements.stageMusic.classList.remove('hidden');
        if (this.elements.btnPipToggle) this.elements.btnPipToggle.classList.add('hidden');
      }

      this.showBottomBar();
      this.setLoading(true);

      if (window.Trove.explorer && typeof window.Trove.explorer.render === 'function') {
        window.Trove.explorer.render();
      }

      try {
        const mediaEntry = await this.getMediaBlobAndUrl(item);

        let thumbUrl = this.thumbnailCache.get(item.path);
        if (!thumbUrl && mediaEntry.blob) {
          thumbUrl = await this.extractThumbnail(mediaEntry.blob, item);
        }
        if (!thumbUrl) {
          thumbUrl = await getSidecarThumbnail(item);
          if (thumbUrl) {
            this.thumbnailCache.set(item.path, thumbUrl);
          }
        }
        if (thumbUrl) {
          this.updateThumbnailUI(thumbUrl, item);
          this.updateMediaSession(thumbUrl);
        }

        const targetEl = this.getActiveElement();
        targetEl.src = mediaEntry.url;
        targetEl.playbackRate = this.playbackRates[this.speedIndex];

        if (startAtSeconds > 0) {
          targetEl.currentTime = startAtSeconds;
          this.savedStartTime = 0;
        }

        if (window.Trove.equalizer) {
          window.Trove.equalizer.initAudioContext();
          window.Trove.equalizer.resume();
        }

        await targetEl.play();
        this.isPlaying = true;
        this.updatePlayStateUI();
        this.updateMediaSession(thumbUrl || this.thumbnailCache.get(item.path) || null);

        if (window.Trove.lyrics && typeof window.Trove.lyrics.onTrackChanged === 'function') {
          window.Trove.lyrics.onTrackChanged(item);
        }

        if (window.Trove.store) {
          window.Trove.store.addRecentTrack(item, startAtSeconds, targetEl.duration || 0);
        }
        this.savePlaybackState();
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
        if (this.elements.barLoadingBadge) this.elements.barLoadingBadge.classList.remove('hidden');
        if (this.elements.btnPlayPause) {
          this.elements.btnPlayPause.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin text-current"></i>';
        }
        if (this.elements.btnExpandedPlay) {
          this.elements.btnExpandedPlay.innerHTML = '<i data-lucide="loader-2" class="w-7 h-7 animate-spin text-current"></i>';
        }
        if (this.elements.videoLoadingOverlay) this.elements.videoLoadingOverlay.classList.remove('hidden');
      } else {
        if (this.elements.barLoadingBadge) this.elements.barLoadingBadge.classList.add('hidden');
        if (this.elements.videoLoadingOverlay) this.elements.videoLoadingOverlay.classList.add('hidden');
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
      if (!activeEl.src || activeEl.src === '' || activeEl.src === window.location.href) {
        await this.playTrack(this.currentTrack, this.savedStartTime || 0);
        return;
      }

      if (activeEl.paused) {
        if (window.Trove.equalizer) {
          window.Trove.equalizer.initAudioContext();
          window.Trove.equalizer.resume();
        }
        activeEl.play().then(() => {
          this.isPlaying = true;
          this.updatePlayStateUI();
          this.savePlaybackState();
        }).catch(console.error);
      } else {
        activeEl.pause();
        this.isPlaying = false;
        this.updatePlayStateUI();
        this.savePlaybackState();
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

    updatePlayStateUI() {
      if (this.isLoading) return;

      const icon = this.isPlaying ? 'pause' : 'play';
      if (this.elements.btnPlayPause) {
        this.elements.btnPlayPause.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4 ml-0.5 text-current"></i>`;
      }
      if (this.elements.btnExpandedPlay) {
        this.elements.btnExpandedPlay.innerHTML = `<i data-lucide="${icon}" class="w-7 h-7 ml-0.5 text-current"></i>`;
      }

      if (this.isPlaying) {
        if (this.elements.barPlayingIndicator) this.elements.barPlayingIndicator.classList.remove('hidden');
        if (this.elements.expandedCoverArt) {
          this.elements.expandedCoverArt.classList.add('ring-2', 'ring-khaki-beige/40');
        }
      } else {
        if (this.elements.barPlayingIndicator) this.elements.barPlayingIndicator.classList.add('hidden');
        if (this.elements.expandedCoverArt) {
          this.elements.expandedCoverArt.classList.remove('ring-2', 'ring-khaki-beige/40');
        }
      }

      if (window.lucide) window.lucide.createIcons();
    },

    showBottomBar() {
      if (!this.elements.bottomPlayBar) return;
      this.elements.bottomPlayBar.style.display = 'block';
      setTimeout(() => {
        this.elements.bottomPlayBar.classList.remove('translate-y-28', 'opacity-0', 'pointer-events-none');
        this.elements.bottomPlayBar.classList.add('translate-y-0', 'opacity-100', 'pointer-events-auto');
      }, 10);
      document.body.classList.add('pb-32', 'sm:pb-28');
      if (MotionAnim) MotionAnim.animateBottomBar(this.elements.bottomPlayBar);
    },

    expand() {
      this.isExpanded = true;
      const mobileNavMenu = document.getElementById('mobile-nav-menu');
      const filterDropdownMenu = document.getElementById('filter-dropdown-menu');
      if (mobileNavMenu) mobileNavMenu.classList.add('hidden');
      if (filterDropdownMenu) filterDropdownMenu.classList.add('hidden');

      if (this.elements.expandedPlayer) {
        this.elements.expandedPlayer.style.display = 'flex';
        this.elements.expandedPlayer.classList.remove('translate-y-full');
        this.elements.expandedPlayer.classList.add('translate-y-0');
      }
      this.savePlaybackState();
      if (MotionAnim) MotionAnim.animateExpandedOpen(this.elements.expandedPlayer, this.elements.expandedCoverArt);
    },

    minimize() {
      this.isExpanded = false;
      this.savePlaybackState();
      if (this.elements.volumePopover) this.elements.volumePopover.classList.add('hidden');
      if (window.Trove.equalizer) window.Trove.equalizer.hide();

      if (MotionAnim) {
        MotionAnim.animateExpandedClose(this.elements.expandedPlayer, () => {
          if (this.elements.expandedPlayer) {
            this.elements.expandedPlayer.classList.remove('translate-y-0');
            this.elements.expandedPlayer.classList.add('translate-y-full');
            this.elements.expandedPlayer.style.display = 'none';
          }
        });
      } else if (this.elements.expandedPlayer) {
        this.elements.expandedPlayer.style.display = 'none';
      }
    },

    toggleShuffle() {
      this.shuffle = !this.shuffle;
      if (this.elements.btnShuffle) {
        if (this.shuffle) {
          this.elements.btnShuffle.classList.add('text-jet-black', 'font-bold');
          this.elements.btnShuffle.classList.remove('text-stone-brown/50');
          this.elements.btnShuffle.title = 'Shuffle On';
        } else {
          this.elements.btnShuffle.classList.remove('text-jet-black', 'font-bold');
          this.elements.btnShuffle.classList.add('text-stone-brown/50');
          this.elements.btnShuffle.title = 'Shuffle Off';
        }
      }
      this.savePlaybackState();
    },

    toggleRepeat() {
      if (this.repeat === 'off') {
        this.repeat = 'all';
        if (this.elements.btnRepeat) {
          this.elements.btnRepeat.setAttribute('title', 'Repeat All');
          this.elements.btnRepeat.classList.add('text-jet-black', 'font-bold');
          this.elements.btnRepeat.classList.remove('text-stone-brown/50');
          this.elements.btnRepeat.innerHTML = '<i data-lucide="repeat" class="w-5 h-5"></i>';
        }
      } else if (this.repeat === 'all') {
        this.repeat = 'one';
        if (this.elements.btnRepeat) {
          this.elements.btnRepeat.setAttribute('title', 'Repeat One');
          this.elements.btnRepeat.innerHTML = '<i data-lucide="repeat-1" class="w-5 h-5"></i>';
        }
      } else {
        this.repeat = 'off';
        if (this.elements.btnRepeat) {
          this.elements.btnRepeat.setAttribute('title', 'Repeat Off');
          this.elements.btnRepeat.classList.remove('text-jet-black', 'font-bold');
          this.elements.btnRepeat.classList.add('text-stone-brown/50');
          this.elements.btnRepeat.innerHTML = '<i data-lucide="repeat" class="w-5 h-5"></i>';
        }
      }
      if (window.lucide) window.lucide.createIcons();
      this.savePlaybackState();
    },

    cycleSpeed() {
      this.speedIndex = (this.speedIndex + 1) % this.playbackRates.length;
      const rate = this.playbackRates[this.speedIndex];
      if (this.elements.btnSpeed) this.elements.btnSpeed.innerText = `${rate}x`;
      if (this.elements.playerAudio) this.elements.playerAudio.playbackRate = rate;
      if (this.elements.playerVideo) this.elements.playerVideo.playbackRate = rate;
      this.savePlaybackState();
    },

    updateMediaSession(thumbUrl = null) {
      if (!('mediaSession' in navigator) || !this.currentTrack) return;

      const track = this.currentTrack;
      let cleanTitle = track.name.replace(/\.[a-zA-Z0-9]+$/, '');
      let cleanArtist = repo.id ? `Trove (${repo.id})` : 'Trove Vault';
      let cleanAlbum = track.parentDir || 'Trove Media Vault';

      if (cleanTitle.includes(' - ')) {
        const parts = cleanTitle.split(' - ');
        cleanArtist = parts[0].trim();
        cleanTitle = parts.slice(1).join(' - ').trim();
      }

      if (!thumbUrl && this.thumbnailCache.has(track.path)) {
        thumbUrl = this.thumbnailCache.get(track.path);
      }

      let resolvedThumb = thumbUrl;
      if (thumbUrl && !thumbUrl.startsWith('blob:') && !thumbUrl.startsWith('data:') && !thumbUrl.startsWith('http')) {
        try {
          resolvedThumb = new URL(thumbUrl, window.location.href).href;
        } catch (_) {}
      }

      const artworkList = resolvedThumb ? [
        { src: resolvedThumb, sizes: '512x512', type: 'image/jpeg' },
        { src: resolvedThumb, sizes: '384x384', type: 'image/jpeg' },
        { src: resolvedThumb, sizes: '256x256', type: 'image/jpeg' },
        { src: resolvedThumb, sizes: '192x192', type: 'image/jpeg' },
        { src: resolvedThumb, sizes: '128x128', type: 'image/jpeg' },
        { src: resolvedThumb, sizes: '96x96', type: 'image/jpeg' }
      ] : [];

      navigator.mediaSession.metadata = new MediaMetadata({
        title: cleanTitle,
        artist: cleanArtist,
        album: cleanAlbum,
        artwork: artworkList
      });

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
      } catch (err) {}
    },

    savePlaybackState() {
      if (!this.currentTrack) return;
      try {
        const activeEl = this.getActiveElement();
        const currentTime = activeEl ? (activeEl.currentTime || 0) : (this.savedStartTime || 0);
        const duration = activeEl && !isNaN(activeEl.duration) ? activeEl.duration : (this.currentTrack.duration || 0);

        const payload = {
          currentTrack: this.currentTrack,
          currentTime: currentTime,
          duration: duration,
          volume: this.volume ?? 1.0,
          speedIndex: this.speedIndex ?? 1,
          repeat: this.repeat || 'off',
          shuffle: this.shuffle || false,
          isExpanded: this.isExpanded || false,
          updatedAt: Date.now()
        };
        localStorage.setItem(PLAYBACK_STATE_KEY, JSON.stringify(payload));
        if (window.Trove.store) {
          window.Trove.store.updateRecentTrackPosition(this.currentTrack.path, currentTime);
        }
      } catch (e) {}
    },

    restorePlaybackState() {
      try {
        const raw = localStorage.getItem(PLAYBACK_STATE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (!saved || !saved.currentTrack) return;

        const track = saved.currentTrack;
        this.currentTrack = track;
        this.volume = typeof saved.volume === 'number' ? saved.volume : 1.0;
        this.speedIndex = typeof saved.speedIndex === 'number' ? saved.speedIndex : 1;
        this.repeat = saved.repeat || 'off';
        this.shuffle = saved.shuffle || false;
        this.savedStartTime = saved.currentTime || 0;

        if (this.elements.btnSpeed) this.elements.btnSpeed.innerText = `${this.playbackRates[this.speedIndex]}x`;
        if (this.elements.playerAudio) this.elements.playerAudio.volume = this.volume;
        if (this.elements.playerVideo) this.elements.playerVideo.volume = this.volume;
        updateVolumeUI(this.volume, false);

        if (this.shuffle && this.elements.btnShuffle) {
          this.elements.btnShuffle.classList.add('text-jet-black', 'font-bold');
          this.elements.btnShuffle.classList.remove('text-stone-brown/50');
        }

        if (this.elements.btnRepeat) {
          if (this.repeat === 'all') {
            this.elements.btnRepeat.classList.add('text-jet-black', 'font-bold');
            this.elements.btnRepeat.classList.remove('text-stone-brown/50');
          } else if (this.repeat === 'one') {
            this.elements.btnRepeat.classList.add('text-jet-black', 'font-bold');
            this.elements.btnRepeat.classList.remove('text-stone-brown/50');
            this.elements.btnRepeat.innerHTML = '<i data-lucide="repeat-1" class="w-5 h-5"></i>';
          }
        }

        if (this.elements.barTrackTitle) this.elements.barTrackTitle.innerText = track.name;
        if (this.elements.barTrackExt) this.elements.barTrackExt.innerText = track.label || 'MEDIA';
        if (this.elements.expandedTrackTitle) this.elements.expandedTrackTitle.innerText = track.name;
        if (this.elements.expandedTrackMeta) {
          this.elements.expandedTrackMeta.innerText = `${track.label || 'MEDIA'} • ${formatBytes(track.size)} • ${track.parentDir || 'Root'}`;
        }
        if (this.elements.expandedSubtitle) {
          this.elements.expandedSubtitle.innerText = `${repo.id} / ${track.parentDir || 'Vault'}`;
        }

        const cur = saved.currentTime || 0;
        const dur = saved.duration || 0;
        if (this.elements.barTimeCurrent) this.elements.barTimeCurrent.innerText = formatTime(cur);
        if (this.elements.expandedTimeCurrent) this.elements.expandedTimeCurrent.innerText = formatTime(cur);
        if (dur > 0) {
          if (this.elements.barTimeDuration) this.elements.barTimeDuration.innerText = formatTime(dur);
          if (this.elements.expandedTimeDuration) this.elements.expandedTimeDuration.innerText = formatTime(dur);
          const pct = (cur / dur) * 100;
          if (this.elements.barProgressSlider) this.elements.barProgressSlider.value = pct;
          if (this.elements.expandedProgressSlider) this.elements.expandedProgressSlider.value = pct;
        }

        const cachedThumb = this.thumbnailCache.get(track.path) || null;
        this.updateThumbnailUI(cachedThumb, track);
        if (cachedThumb) {
          this.updateMediaSession(cachedThumb);
        }

        this.showBottomBar();
        this.updatePlayStateUI();

        if (window.lucide) window.lucide.createIcons();
      } catch (e) {
        console.warn('Error restoring playback state:', e);
      }
    },

    init() {
      this.elements = {
        playerAudio: document.getElementById('player-audio'),
        playerVideo: document.getElementById('player-video'),
        bottomPlayBar: document.getElementById('bottom-play-bar'),
        barThumbImg: document.getElementById('bar-thumb-img'),
        barTypeIcon: document.getElementById('bar-type-icon'),
        barTrackTitle: document.getElementById('bar-track-title'),
        barTrackExt: document.getElementById('bar-track-ext'),
        barPlayingIndicator: document.getElementById('bar-playing-indicator'),
        barLoadingBadge: document.getElementById('bar-loading-badge'),
        btnPlayPause: document.getElementById('btn-play-pause'),
        btnPrev: document.getElementById('btn-prev'),
        btnNext: document.getElementById('btn-next'),
        btnExpandPlayer: document.getElementById('btn-expand-player'),
        barExpandTrigger: document.getElementById('bar-expand-trigger'),
        barTimeCurrent: document.getElementById('bar-time-current'),
        barTimeDuration: document.getElementById('bar-time-duration'),
        barProgressSlider: document.getElementById('bar-progress-slider'),
        expandedPlayer: document.getElementById('expanded-player'),
        btnMinimizePlayer: document.getElementById('btn-minimize-player'),
        expandedCoverArt: document.getElementById('expanded-cover-art'),
        expandedCoverImg: document.getElementById('expanded-cover-img'),
        expandedCoverFallback: document.getElementById('expanded-cover-fallback'),
        expandedCoverIcon: document.getElementById('expanded-cover-icon'),
        expandedTrackTitle: document.getElementById('expanded-track-title'),
        expandedTrackMeta: document.getElementById('expanded-track-meta'),
        expandedSubtitle: document.getElementById('expanded-subtitle'),
        expandedTimeCurrent: document.getElementById('expanded-time-current'),
        expandedTimeDuration: document.getElementById('expanded-time-duration'),
        expandedProgressSlider: document.getElementById('expanded-progress-slider'),
        btnExpandedPlay: document.getElementById('btn-expanded-play'),
        btnExpandedPrev: document.getElementById('btn-expanded-prev'),
        btnExpandedNext: document.getElementById('btn-expanded-next'),
        btnShuffle: document.getElementById('btn-shuffle'),
        btnRepeat: document.getElementById('btn-repeat'),
        btnSpeed: document.getElementById('btn-speed'),
        stageMusic: document.getElementById('stage-music'),
        stageVideo: document.getElementById('stage-video'),
        btnPipToggle: document.getElementById('btn-pip-toggle'),
        videoLoadingOverlay: document.getElementById('video-loading-overlay'),
        activeQueueCounter: document.getElementById('active-queue-counter'),
        btnVolumePill: document.getElementById('btn-volume-pill'),
        volumePopover: document.getElementById('volume-popover'),
        volumeWrapper: document.getElementById('volume-wrapper'),
        volumeSlider: document.getElementById('volume-slider'),
        btnMute: document.getElementById('btn-mute'),
        volumePercentageLabel: document.getElementById('volume-percentage-label'),
        volumePopoverPct: document.getElementById('volume-popover-pct'),
        volumeIcon: document.getElementById('volume-icon'),
        popoverMuteIcon: document.getElementById('popover-mute-icon')
      };

      this.setupMediaEventListeners(this.elements.playerAudio);
      this.setupMediaEventListeners(this.elements.playerVideo);
      this.setupUIEventListeners();
      this.restorePlaybackState();
    },

    setupMediaEventListeners(el) {
      if (!el) return;
      let lastSave = 0;

      el.addEventListener('timeupdate', () => {
        if (el !== this.getActiveElement()) return;

        const cur = el.currentTime || 0;
        const dur = el.duration || 0;
        const pct = dur > 0 ? (cur / dur) * 100 : 0;

        if (!this.isSeeking) {
          if (this.elements.barProgressSlider) this.elements.barProgressSlider.value = pct;
          if (this.elements.expandedProgressSlider) this.elements.expandedProgressSlider.value = pct;
        }

        if (this.elements.barTimeCurrent) this.elements.barTimeCurrent.innerText = formatTime(cur);
        if (this.elements.expandedTimeCurrent) this.elements.expandedTimeCurrent.innerText = formatTime(cur);

        if (dur > 0 && !isNaN(dur)) {
          if (this.elements.barTimeDuration) this.elements.barTimeDuration.innerText = formatTime(dur);
          if (this.elements.expandedTimeDuration) this.elements.expandedTimeDuration.innerText = formatTime(dur);
        }

        if ('mediaSession' in navigator && dur > 0 && !isNaN(dur)) {
          try {
            navigator.mediaSession.setPositionState({
              duration: dur,
              playbackRate: el.playbackRate || 1.0,
              position: Math.min(cur, dur)
            });
          } catch (_) {}
        }

        const now = Date.now();
        if (now - lastSave > 2500) {
          lastSave = now;
          this.savePlaybackState();
        }
      });

      el.addEventListener('play', () => {
        if (el === this.getActiveElement()) {
          this.isPlaying = true;
          this.updatePlayStateUI();
          if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing';
          }
          this.savePlaybackState();
        }
      });

      el.addEventListener('pause', () => {
        if (el === this.getActiveElement()) {
          this.isPlaying = false;
          this.updatePlayStateUI();
          if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'paused';
          }
          this.savePlaybackState();
        }
      });

      el.addEventListener('ended', () => {
        if (el === this.getActiveElement()) {
          this.playNext();
          this.savePlaybackState();
        }
      });
    },

    setupUIEventListeners() {
      // Play/Pause
      if (this.elements.btnPlayPause) {
        this.elements.btnPlayPause.addEventListener('click', (e) => {
          e.stopPropagation();
          if (MotionAnim) MotionAnim.pulseButton(this.elements.btnPlayPause);
          this.togglePlayPause();
        });
      }
      if (this.elements.btnExpandedPlay) {
        this.elements.btnExpandedPlay.addEventListener('click', () => {
          if (MotionAnim) MotionAnim.pulseButton(this.elements.btnExpandedPlay);
          this.togglePlayPause();
        });
      }

      // Next / Prev
      if (this.elements.btnNext) {
        this.elements.btnNext.addEventListener('click', (e) => {
          e.stopPropagation();
          if (MotionAnim) MotionAnim.pulseButton(this.elements.btnNext);
          this.playNext();
        });
      }
      if (this.elements.btnExpandedNext) {
        this.elements.btnExpandedNext.addEventListener('click', () => {
          if (MotionAnim) MotionAnim.pulseButton(this.elements.btnExpandedNext);
          this.playNext();
        });
      }

      if (this.elements.btnPrev) {
        this.elements.btnPrev.addEventListener('click', (e) => {
          e.stopPropagation();
          if (MotionAnim) MotionAnim.pulseButton(this.elements.btnPrev);
          this.playPrev();
        });
      }
      if (this.elements.btnExpandedPrev) {
        this.elements.btnExpandedPrev.addEventListener('click', () => {
          if (MotionAnim) MotionAnim.pulseButton(this.elements.btnExpandedPrev);
          this.playPrev();
        });
      }

      // Expand / Minimize
      if (this.elements.barExpandTrigger) {
        this.elements.barExpandTrigger.addEventListener('click', () => this.expand());
      }
      if (this.elements.btnExpandPlayer) {
        this.elements.btnExpandPlayer.addEventListener('click', (e) => {
          e.stopPropagation();
          this.expand();
        });
      }
      if (this.elements.btnMinimizePlayer) {
        this.elements.btnMinimizePlayer.addEventListener('click', () => this.minimize());
      }

      // Progress sliders
      const setupSlider = (slider) => {
        if (!slider) return;
        slider.addEventListener('mousedown', () => { this.isSeeking = true; });
        slider.addEventListener('touchstart', () => { this.isSeeking = true; });

        slider.addEventListener('input', (e) => {
          const activeEl = this.getActiveElement();
          if (activeEl && activeEl.duration) {
            const targetSec = (e.target.value / 100) * activeEl.duration;
            if (this.elements.barTimeCurrent) this.elements.barTimeCurrent.innerText = formatTime(targetSec);
            if (this.elements.expandedTimeCurrent) this.elements.expandedTimeCurrent.innerText = formatTime(targetSec);
          }
        });

        const finishSeeking = (e) => {
          if (!this.isSeeking) return;
          this.isSeeking = false;
          const activeEl = this.getActiveElement();
          if (activeEl && activeEl.duration) {
            activeEl.currentTime = (e.target.value / 100) * activeEl.duration;
            this.savePlaybackState();
          }
        };

        slider.addEventListener('mouseup', finishSeeking);
        slider.addEventListener('touchend', finishSeeking);
        slider.addEventListener('change', finishSeeking);
      };

      setupSlider(this.elements.barProgressSlider);
      setupSlider(this.elements.expandedProgressSlider);

      // Shuffle & Repeat
      if (this.elements.btnShuffle) {
        this.elements.btnShuffle.addEventListener('click', () => this.toggleShuffle());
      }
      if (this.elements.btnRepeat) {
        this.elements.btnRepeat.addEventListener('click', () => this.toggleRepeat());
      }
      if (this.elements.btnSpeed) {
        this.elements.btnSpeed.addEventListener('click', () => this.cycleSpeed());
      }

      // Volume & Mute
      if (this.elements.btnVolumePill && this.elements.volumePopover) {
        this.elements.btnVolumePill.addEventListener('click', (e) => {
          e.stopPropagation();
          this.elements.volumePopover.classList.toggle('hidden');
          if (window.lucide) window.lucide.createIcons();
        });

        document.addEventListener('click', (e) => {
          if (this.elements.volumeWrapper && !this.elements.volumeWrapper.contains(e.target)) {
            this.elements.volumePopover.classList.add('hidden');
          }
        });
      }

      if (this.elements.volumeSlider) {
        this.elements.volumeSlider.addEventListener('input', (e) => {
          const vol = parseFloat(e.target.value);
          const activeEl = this.getActiveElement();
          if (activeEl) activeEl.muted = false;
          if (this.elements.playerAudio) this.elements.playerAudio.volume = vol;
          if (this.elements.playerVideo) this.elements.playerVideo.volume = vol;
          this.volume = vol;
          updateVolumeUI(vol, false);
          this.savePlaybackState();
        });
      }

      if (this.elements.btnMute) {
        this.elements.btnMute.addEventListener('click', (e) => {
          e.stopPropagation();
          const activeEl = this.getActiveElement();
          activeEl.muted = !activeEl.muted;
          updateVolumeUI(this.volume, activeEl.muted);
          this.savePlaybackState();
        });
      }

      // Picture in picture
      if (this.elements.btnPipToggle && this.elements.playerVideo) {
        this.elements.btnPipToggle.addEventListener('click', async () => {
          try {
            if (document.pictureInPictureElement) {
              await document.exitPictureInPicture();
            } else if (document.pictureInPictureEnabled && !this.elements.playerVideo.paused) {
              await this.elements.playerVideo.requestPictureInPicture();
            }
          } catch (_) {}
        });
      }

      // Video loadeddata frame capture
      if (this.elements.playerVideo) {
        this.elements.playerVideo.addEventListener('loadeddata', async () => {
          if (this.currentTrack && this.currentTrack.category === 'video') {
            if (!this.thumbnailCache.has(this.currentTrack.path)) {
              let thumb = await getSidecarThumbnail(this.currentTrack);
              if (!thumb) {
                thumb = captureVideoFrame(this.elements.playerVideo);
              }
              if (thumb) {
                this.thumbnailCache.set(this.currentTrack.path, thumb);
                this.updateThumbnailUI(thumb, this.currentTrack);
                this.updateMediaSession(thumb);
              }
            }
          }
        });
      }
    }
  };

  // Export
  window.Trove.player = Player;
  window.player = Player;
})();

