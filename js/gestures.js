/**
 * Trove Media Vault - Native Mobile Touch Gestures Engine
 *
 * Implements 60/120fps hardware-accelerated gestures with authentic spring physics:
 *   1. Pull-Down to Refresh (Vault Explorer #file-list) with natural logarithmic rubber-band
 *   2. Dual-Direction Row Swipe:
 *        - Swipe Right -> Add to Queue (Emerald reveal)
 *        - Swipe Left  -> Add to Playlist (Amber reveal)
 *   3. Long-Press / Haptic Touch on Row (450ms) -> Floating Track Action Context Sheet
 *   4. Double-Tap Cover Art: Left half rewinds 10s, right half jumps forward 10s (with ripple overlay)
 *   5. Expanded Player Gestures: Fluid drag-down to minimize & 3D tilt horizontal swipe to skip
 *   6. Mini-Player Bottom Bar: Swipe up to expand, swipe left/right to skip with click suppression
 *   7. Queue Drawer: Horizontal swipe to flip between "Current Queue" and "Your Playlists" tabs
 *
 * Performance Architecture:
 *   - Decoupled from raw touchmove sampling: visual DOM mutations are VSync-synchronized via requestAnimationFrame
 *   - Strictly GPU-composited transform: translate3d and opacity properties
 *   - Dynamic GPU layer promotion (will-change: transform) on active gestures
 *   - Zero layout-thrashing dynamic borderRadius calculations
 */
(function() {
  window.Trove = window.Trove || {};

  const GesturesManager = {
    isRefreshing: false,
    isSwipingRow: false,
    contextItem: null,

    init() {
      this.initPullToRefresh();
      this.initRowGestures();
      this.initExpandedPlayerGestures();
      this.initBottomBarGestures();
      this.initQueueDrawerGestures();
      this.initContextSheet();
    },

    // 1. PULL-DOWN TO REFRESH (#file-list)
    initPullToRefresh() {
      const fileList = document.getElementById('file-list');
      const indicator = document.getElementById('pull-refresh-indicator');
      const icon = document.getElementById('pull-refresh-icon');
      const text = document.getElementById('pull-refresh-text');
      if (!fileList || !indicator) return;

      let startY = 0;
      let startX = 0;
      let isPulling = false;
      let pullDistance = 0;
      let pullRafId = null;
      let wasOverThreshold = false;
      const THRESHOLD = 65;

      fileList.addEventListener('touchstart', (e) => {
        if (this.isRefreshing) return;
        if (fileList.scrollTop <= 0) {
          startY = e.touches[0].clientY;
          startX = e.touches[0].clientX;
          isPulling = false;
          pullDistance = 0;
          wasOverThreshold = false;
          indicator.style.willChange = 'transform, opacity';
        }
      }, { passive: true });

      fileList.addEventListener('touchmove', (e) => {
        if (this.isRefreshing || startY === 0) return;
        if (fileList.scrollTop > 0) {
          isPulling = false;
          return;
        }

        const currentY = e.touches[0].clientY;
        const currentX = e.touches[0].clientX;
        const diffY = currentY - startY;
        const diffX = currentX - startX;

        // Disambiguate downward pull from horizontal scroll
        if (diffY > 6 && Math.abs(diffY) > Math.abs(diffX) * 1.3) {
          isPulling = true;
          // Organic logarithmic rubber-band damping
          pullDistance = Math.min(95, Math.pow(diffY, 0.82) * 1.6);

          if (e.cancelable) e.preventDefault();

          if (!pullRafId) {
            pullRafId = requestAnimationFrame(() => {
              pullRafId = null;
              if (!isPulling) return;
              indicator.style.transition = 'none';
              indicator.style.opacity = `${Math.min(1, pullDistance / 40)}`;
              indicator.style.transform = `translate3d(-50%, ${pullDistance - 38}px, 0)`;

              if (icon) {
                const rot = (pullDistance / THRESHOLD) * 360;
                icon.style.transform = `rotate(${rot}deg)`;
              }

              const isOver = pullDistance >= THRESHOLD;
              if (isOver !== wasOverThreshold) {
                wasOverThreshold = isOver;
                if (isOver) {
                  if (text) text.innerText = 'Release to refresh';
                  indicator.classList.add('border-emerald-500/50', 'bg-emerald-50/95', 'dark:bg-emerald-950/95');
                } else {
                  if (text) text.innerText = 'Pull to refresh';
                  indicator.classList.remove('border-emerald-500/50', 'bg-emerald-50/95', 'dark:bg-emerald-950/95');
                }
              }
            });
          }
        }
      }, { passive: false });

      const finishPull = () => {
        if (pullRafId) {
          cancelAnimationFrame(pullRafId);
          pullRafId = null;
        }
        if (!isPulling) return;
        isPulling = false;
        startY = 0;

        if (pullDistance >= THRESHOLD && !this.isRefreshing) {
          this.isRefreshing = true;
          if (navigator.vibrate) navigator.vibrate(25);

          if (text) text.innerText = 'Refreshing vault...';
          if (icon) {
            icon.style.transform = '';
            icon.classList.add('animate-spin');
          }
          indicator.style.transition = 'transform 0.28s cubic-bezier(0.175, 0.885, 0.32, 1.15), opacity 0.25s ease-out';
          indicator.style.transform = 'translate3d(-50%, 22px, 0)';
          indicator.style.opacity = '1';

          if (window.Trove.explorer && typeof window.Trove.explorer.loadRepository === 'function') {
            window.Trove.explorer.loadRepository(true).finally(() => {
              setTimeout(() => {
                indicator.style.transition = 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s ease-in';
                indicator.style.transform = 'translate3d(-50%, -48px, 0)';
                indicator.style.opacity = '0';
                setTimeout(() => {
                  if (icon) icon.classList.remove('animate-spin');
                  indicator.classList.remove('border-emerald-500/50', 'bg-emerald-50/95', 'dark:bg-emerald-950/95');
                  indicator.style.willChange = '';
                  this.isRefreshing = false;
                  if (window.lucide) window.lucide.createIcons();
                }, 250);
              }, 400);
            });
          } else {
            this.isRefreshing = false;
            indicator.style.willChange = '';
          }
        } else {
          indicator.style.transition = 'transform 0.24s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.2s ease-out';
          indicator.style.transform = 'translate3d(-50%, -48px, 0)';
          indicator.style.opacity = '0';
          setTimeout(() => {
            indicator.style.willChange = '';
          }, 250);
        }
        pullDistance = 0;
      };

      fileList.addEventListener('touchend', finishPull, { passive: true });
      fileList.addEventListener('touchcancel', finishPull, { passive: true });
    },

    // 2. DUAL-DIRECTION ROW SWIPING & LONG-PRESS CONTEXT SHEET
    initRowGestures() {
      const fileList = document.getElementById('file-list');
      if (!fileList) return;

      let activeRow = null;
      let activeWrapper = null;
      let revealQueue = null;
      let revealPlaylist = null;
      let queueBadge = null;
      let playlistBadge = null;
      let startX = 0;
      let startY = 0;
      let isHorizontal = false;
      let isDetermined = false;
      let currentDeltaX = 0;
      let longPressTimer = null;
      let isLongPress = false;
      let rowRafId = null;
      let isQueueHigh = false;
      let isPlaylistHigh = false;
      const SWIPE_THRESHOLD = 75;

      fileList.addEventListener('touchstart', (e) => {
        const row = e.target.closest('.file-row');
        if (!row || row.dataset.isDir === 'true') {
          activeRow = null;
          return;
        }

        // Avoid swiping if touching quick action button
        if (e.target.closest('.btn-add-to-playlist')) return;

        activeRow = row;
        activeWrapper = row.closest('.file-row-wrapper');
        revealQueue = activeWrapper ? activeWrapper.querySelector('.swipe-queue-reveal') : null;
        revealPlaylist = activeWrapper ? activeWrapper.querySelector('.swipe-playlist-reveal') : null;
        queueBadge = revealQueue ? revealQueue.querySelector('div') : null;
        playlistBadge = revealPlaylist ? revealPlaylist.querySelector('div') : null;

        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        isHorizontal = false;
        isDetermined = false;
        currentDeltaX = 0;
        this.isSwipingRow = false;
        isLongPress = false;
        isQueueHigh = false;
        isPlaylistHigh = false;

        // Long-Press Timer (450ms Haptic Touch)
        clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => {
          if (!isHorizontal && activeRow) {
            isLongPress = true;
            this.isSwipingRow = true; // suppress ensuing row click
            if (navigator.vibrate) navigator.vibrate(35);

            const filePath = activeRow.dataset.path;
            const state = window.Trove.state || {};
            const item = (state.allItems || []).find(i => i.path === filePath);
            if (item) {
              this.openContextSheet(item);
            }
          }
        }, 450);
      }, { passive: true });

      fileList.addEventListener('touchmove', (e) => {
        if (!activeRow) return;

        const currentX = e.touches[0].clientX;
        const currentY = e.touches[0].clientY;
        const diffX = currentX - startX;
        const diffY = currentY - startY;

        // Cancel long press if finger moved
        if (Math.abs(diffX) > 8 || Math.abs(diffY) > 8) {
          clearTimeout(longPressTimer);
        }

        if (isLongPress) return;

        // Disambiguate horizontal swipe from vertical list scroll
        if (!isDetermined && (Math.abs(diffX) > 8 || Math.abs(diffY) > 8)) {
          isDetermined = true;
          if (Math.abs(diffX) > 8 && Math.abs(diffX) > Math.abs(diffY) * 1.3) {
            isHorizontal = true;
            this.isSwipingRow = true;
            activeRow.classList.add('select-none');
            activeRow.style.willChange = 'transform';
            activeRow.style.transition = 'none';
          } else {
            isHorizontal = false;
            activeRow = null;
            return;
          }
        }

        if (isHorizontal) {
          if (e.cancelable) e.preventDefault();

          if (diffX > 0) {
            // SWIPE RIGHT -> Add to Queue (Queue Underlayer)
            currentDeltaX = diffX > 80 ? 80 + (diffX - 80) * 0.35 : diffX;
          } else {
            // SWIPE LEFT -> Add to Playlist (Playlist Underlayer)
            const absDiff = Math.abs(diffX);
            const cappedDelta = absDiff > 80 ? 80 + (absDiff - 80) * 0.35 : absDiff;
            currentDeltaX = -cappedDelta;
          }

          if (!rowRafId) {
            rowRafId = requestAnimationFrame(() => {
              rowRafId = null;
              if (!activeRow || !isHorizontal) return;

              activeRow.style.transform = `translate3d(${currentDeltaX}px, 0, 0)`;

              if (currentDeltaX > 0 && revealQueue) {
                revealQueue.style.display = 'flex';
                if (revealPlaylist) revealPlaylist.style.display = 'none';
                const scale = Math.min(1.08, 0.8 + (currentDeltaX / SWIPE_THRESHOLD) * 0.28);
                if (queueBadge) queueBadge.style.transform = `scale(${scale})`;

                const isHigh = currentDeltaX >= SWIPE_THRESHOLD;
                if (isHigh !== isQueueHigh) {
                  isQueueHigh = isHigh;
                  if (isHigh) {
                    revealQueue.classList.remove('bg-emerald-600', 'dark:bg-emerald-600');
                    revealQueue.classList.add('bg-emerald-500', 'dark:bg-emerald-500');
                    if (queueBadge) queueBadge.classList.add('bg-white/30');
                  } else {
                    revealQueue.classList.add('bg-emerald-600', 'dark:bg-emerald-600');
                    revealQueue.classList.remove('bg-emerald-500', 'dark:bg-emerald-500');
                    if (queueBadge) queueBadge.classList.remove('bg-white/30');
                  }
                }
              } else if (currentDeltaX < 0 && revealPlaylist) {
                revealPlaylist.style.display = 'flex';
                if (revealQueue) revealQueue.style.display = 'none';
                const absDelta = Math.abs(currentDeltaX);
                const scale = Math.min(1.08, 0.8 + (absDelta / SWIPE_THRESHOLD) * 0.28);
                if (playlistBadge) playlistBadge.style.transform = `scale(${scale})`;

                const isHigh = absDelta >= SWIPE_THRESHOLD;
                if (isHigh !== isPlaylistHigh) {
                  isPlaylistHigh = isHigh;
                  if (isHigh) {
                    revealPlaylist.classList.remove('bg-amber-600', 'dark:bg-amber-600');
                    revealPlaylist.classList.add('bg-amber-500', 'dark:bg-amber-500');
                    if (playlistBadge) playlistBadge.classList.add('bg-white/30');
                  } else {
                    revealPlaylist.classList.add('bg-amber-600', 'dark:bg-amber-600');
                    revealPlaylist.classList.remove('bg-amber-500', 'dark:bg-amber-500');
                    if (playlistBadge) playlistBadge.classList.remove('bg-white/30');
                  }
                }
              }
            });
          }
        }
      }, { passive: false });

      const endRowSwipe = () => {
        clearTimeout(longPressTimer);
        if (rowRafId) {
          cancelAnimationFrame(rowRafId);
          rowRafId = null;
        }
        if (!activeRow) return;

        const row = activeRow;
        const qReveal = revealQueue;
        const pReveal = revealPlaylist;
        const qBadge = queueBadge;
        const pBadge = playlistBadge;
        const finalDeltaX = currentDeltaX;
        activeRow = null;
        activeWrapper = null;
        revealQueue = null;
        revealPlaylist = null;
        queueBadge = null;
        playlistBadge = null;

        if (isHorizontal) {
          const filePath = row.dataset.path;
          const state = window.Trove.state || {};
          const item = (state.allItems || []).find(i => i.path === filePath);

          if (finalDeltaX >= SWIPE_THRESHOLD) {
            // Action 1: Add to Queue
            if (navigator.vibrate) navigator.vibrate(30);
            if (item && window.Trove.playlists && typeof window.Trove.playlists.addToQueue === 'function') {
              window.Trove.playlists.addToQueue(item);
            }
          } else if (finalDeltaX <= -SWIPE_THRESHOLD) {
            // Action 2: Add to Playlist Modal
            if (navigator.vibrate) navigator.vibrate(30);
            if (item && window.Trove.playlists && typeof window.Trove.playlists.openAddModal === 'function') {
              window.Trove.playlists.openAddModal(item);
            }
          }
        }

        // Hardware-accelerated CSS transition glide return
        row.style.transition = 'transform 0.24s cubic-bezier(0.22, 1, 0.36, 1)';
        row.style.transform = 'translate3d(0, 0, 0)';

        let hasHandledReset = false;
        const handleRowReset = () => {
          if (hasHandledReset) return;
          hasHandledReset = true;
          row.removeEventListener('transitionend', handleRowReset);

          row.style.transition = '';
          row.style.transform = '';
          row.style.willChange = '';
          row.classList.remove('select-none');

          if (qReveal) {
            qReveal.style.display = 'none';
            qReveal.classList.add('bg-emerald-600', 'dark:bg-emerald-600');
            qReveal.classList.remove('bg-emerald-500', 'dark:bg-emerald-500');
            if (qBadge) { qBadge.style.transform = ''; qBadge.classList.remove('bg-white/30'); }
          }
          if (pReveal) {
            pReveal.style.display = 'none';
            pReveal.classList.add('bg-amber-600', 'dark:bg-amber-600');
            pReveal.classList.remove('bg-amber-500', 'dark:bg-amber-500');
            if (pBadge) { pBadge.style.transform = ''; pBadge.classList.remove('bg-white/30'); }
          }

          setTimeout(() => {
            this.isSwipingRow = false;
          }, 60);
        };

        row.addEventListener('transitionend', handleRowReset);
        setTimeout(handleRowReset, 280);
      };

      fileList.addEventListener('touchend', endRowSwipe, { passive: true });
      fileList.addEventListener('touchcancel', endRowSwipe, { passive: true });

      // Suppress clicks on rows if user just swiped or long-pressed
      fileList.addEventListener('click', (e) => {
        if (this.isSwipingRow) {
          e.stopPropagation();
          e.preventDefault();
        }
      }, true);
    },

    // 3. EXPANDED PLAYER GESTURES (DOUBLE-TAP SEEK, DRAG DOWN DISMISS & 3D TILT HORIZONTAL SWIPE)
    initExpandedPlayerGestures() {
      const expandedPlayer = document.getElementById('expanded-player');
      const coverArt = document.getElementById('expanded-cover-art');
      if (!expandedPlayer) return;

      let startX = 0;
      let startY = 0;
      let diffX = 0;
      let diffY = 0;
      let isTracking = false;
      let gestureMode = null; // 'down' | 'horizontal' | null
      let isDetermined = false;
      let expandedRafId = null;

      // Double-Tap tracking state
      let lastTapTime = 0;
      let lastTapX = 0;

      expandedPlayer.addEventListener('touchstart', (e) => {
        const playerState = window.Trove.player || {};
        if (playerState.isExpanded === false) return;

        // Ignore touches on interactive controls (buttons, sliders, select, lyrics scroll container)
        if (e.target.closest('button, input, select, a, #lyrics-scroll-body, #expanded-lyrics-container')) return;

        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        diffX = 0;
        diffY = 0;
        isTracking = true;
        gestureMode = null;
        isDetermined = false;

        expandedPlayer.style.willChange = 'transform, opacity';
        if (coverArt) coverArt.style.willChange = 'transform, opacity';
      }, { passive: true });

      expandedPlayer.addEventListener('touchmove', (e) => {
        if (!isTracking) return;

        const currentX = e.touches[0].clientX;
        const currentY = e.touches[0].clientY;
        diffX = currentX - startX;
        diffY = currentY - startY;

        const absX = Math.abs(diffX);
        const absY = Math.abs(diffY);

        if (!isDetermined && (absX > 8 || absY > 8)) {
          isDetermined = true;
          // Downward drag to dismiss
          if (diffY > 8 && diffY > absX * 1.1) {
            gestureMode = 'down';
            expandedPlayer.style.transition = 'none';
          } else if (absX > 8 && absX > absY * 1.1) {
            // Horizontal swipe to skip track
            gestureMode = 'horizontal';
            if (coverArt) coverArt.style.transition = 'none';
          } else {
            gestureMode = null;
            isTracking = false;
            expandedPlayer.style.willChange = '';
            if (coverArt) coverArt.style.willChange = '';
            return;
          }
        }

        if (gestureMode) {
          if (e.cancelable) e.preventDefault();

          if (!expandedRafId) {
            expandedRafId = requestAnimationFrame(() => {
              expandedRafId = null;
              if (!isTracking) return;

              if (gestureMode === 'down' && diffY > 0) {
                // Pure GPU compositor properties: translate3d + scale + opacity
                // NO dynamic border-radius changes to eliminate CPU rasterization jank!
                const pullDown = diffY * 0.85;
                const scale = Math.max(0.92, 1 - (pullDown / 2500));
                const opacity = Math.max(0.72, 1 - (pullDown / 650));
                expandedPlayer.style.transform = `translate3d(0, ${pullDown}px, 0) scale(${scale})`;
                expandedPlayer.style.opacity = `${opacity}`;
              } else if (gestureMode === 'horizontal' && coverArt) {
                // Visual horizontal travel with subtle 3D rotational tilt on cover art
                const travelX = diffX * 0.65;
                const tilt = (diffX / 300) * 7;
                const fade = Math.max(0.45, 1 - (absX / 320));
                coverArt.style.transform = `translate3d(${travelX}px, 0, 0) rotate(${tilt}deg)`;
                coverArt.style.opacity = `${fade}`;
              }
            });
          }
        }
      }, { passive: false });

      const finishExpandedGesture = (e) => {
        if (expandedRafId) {
          cancelAnimationFrame(expandedRafId);
          expandedRafId = null;
        }
        if (!isTracking) return;
        isTracking = false;

        const absX = Math.abs(diffX);
        const absY = Math.abs(diffY);

        // Check for Double-Tap on Cover Art if movement was negligible
        if (absX < 10 && absY < 10 && coverArt) {
          const now = Date.now();
          const targetIsCover = Boolean(e.target && e.target.closest('#expanded-cover-art'));

          if (targetIsCover && (now - lastTapTime < 320) && Math.abs(startX - lastTapX) < 80) {
            lastTapTime = 0;
            const rect = coverArt.getBoundingClientRect();
            const isLeft = (startX - rect.left) < (rect.width / 2);

            if (navigator.vibrate) navigator.vibrate(20);
            if (isLeft) {
              if (window.Trove.player) window.Trove.player.seekDelta(-10);
              this.triggerDoubleTapFeedback('left');
            } else {
              if (window.Trove.player) window.Trove.player.seekDelta(10);
              this.triggerDoubleTapFeedback('right');
            }
            expandedPlayer.style.willChange = '';
            coverArt.style.willChange = '';
            return;
          } else if (targetIsCover) {
            lastTapTime = now;
            lastTapX = startX;
          }
        }

        if (gestureMode === 'down') {
          const THRESHOLD_MINIMIZE = 80;
          if (diffY >= THRESHOLD_MINIMIZE) {
            if (navigator.vibrate) navigator.vibrate(20);
            // Single, clean dismissal: animate directly off-screen
            expandedPlayer.style.transition = 'transform 0.24s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.2s ease-out';
            expandedPlayer.style.transform = 'translate3d(0, 100%, 0) scale(0.9)';
            expandedPlayer.style.opacity = '0';
            setTimeout(() => {
              expandedPlayer.style.willChange = '';
              expandedPlayer.style.transform = '';
              expandedPlayer.style.opacity = '';
              if (window.Trove.player && typeof window.Trove.player.minimize === 'function') {
                window.Trove.player.minimize(true);
              }
            }, 230);
          } else {
            // Elastic spring back to fullscreen
            expandedPlayer.style.transition = 'transform 0.26s cubic-bezier(0.175, 0.885, 0.32, 1.1), opacity 0.22s ease-out';
            expandedPlayer.style.transform = 'translate3d(0, 0, 0) scale(1)';
            expandedPlayer.style.opacity = '1';
            setTimeout(() => {
              expandedPlayer.style.transition = '';
              expandedPlayer.style.transform = '';
              expandedPlayer.style.opacity = '';
              expandedPlayer.style.willChange = '';
            }, 270);
          }
        } else if (gestureMode === 'horizontal') {
          const THRESHOLD_SKIP = 48;

          if (absX >= THRESHOLD_SKIP) {
            if (navigator.vibrate) navigator.vibrate(25);
            const isNext = diffX < 0; // Swipe Left = Next, Swipe Right = Previous

            if (coverArt) {
              // Phase 1: Slide out current cover in swipe direction
              coverArt.style.transition = 'transform 0.16s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.14s ease-out';
              coverArt.style.transform = `translate3d(${isNext ? -120 : 120}px, 0, 0) rotate(${isNext ? -8 : 8}deg)`;
              coverArt.style.opacity = '0';

              let hasHandledExit = false;
              const handleExit = () => {
                if (hasHandledExit) return;
                hasHandledExit = true;
                coverArt.removeEventListener('transitionend', handleExit);

                // Phase 2: Trigger track change while cover is invisible
                if (window.Trove.player) {
                  if (isNext) {
                    if (typeof window.Trove.player.playNext === 'function') window.Trove.player.playNext();
                    else if (typeof window.Trove.player.next === 'function') window.Trove.player.next();
                  } else {
                    if (typeof window.Trove.player.playPrev === 'function') window.Trove.player.playPrev();
                    else if (typeof window.Trove.player.previous === 'function') window.Trove.player.previous();
                  }
                }

                // Phase 3: Instant reposition on opposite side (no transition)
                coverArt.style.transition = 'none';
                coverArt.style.transform = `translate3d(${isNext ? 80 : -80}px, 0, 0) rotate(${isNext ? 6 : -6}deg) scale(0.95)`;
                coverArt.style.opacity = '0';

                // Force layout reflow so the browser commits the off-screen start coordinates
                void coverArt.offsetWidth;

                // Phase 4: Smooth glide into resting center (0, 0, 0) with zero overshoot
                coverArt.style.transition = 'transform 0.26s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease-out';
                coverArt.style.transform = 'translate3d(0, 0, 0) rotate(0deg) scale(1)';
                coverArt.style.opacity = '1';

                let hasHandledEntry = false;
                const handleEntry = () => {
                  if (hasHandledEntry) return;
                  hasHandledEntry = true;
                  coverArt.removeEventListener('transitionend', handleEntry);
                  coverArt.style.transition = '';
                  coverArt.style.transform = '';
                  coverArt.style.opacity = '';
                  coverArt.style.willChange = '';
                };

                coverArt.addEventListener('transitionend', handleEntry);
                setTimeout(handleEntry, 340);
              };

              coverArt.addEventListener('transitionend', handleExit);
              setTimeout(handleExit, 200);

            } else if (window.Trove.player) {
              if (isNext) {
                if (typeof window.Trove.player.playNext === 'function') window.Trove.player.playNext();
                else if (typeof window.Trove.player.next === 'function') window.Trove.player.next();
              } else {
                if (typeof window.Trove.player.playPrev === 'function') window.Trove.player.playPrev();
                else if (typeof window.Trove.player.previous === 'function') window.Trove.player.previous();
              }
            }
          } else if (coverArt) {
            // Spring smoothly back to center
            coverArt.style.transition = 'transform 0.24s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease-out';
            coverArt.style.transform = 'translate3d(0, 0, 0) rotate(0deg) scale(1)';
            coverArt.style.opacity = '1';

            let hasHandledReset = false;
            const handleReset = () => {
              if (hasHandledReset) return;
              hasHandledReset = true;
              coverArt.removeEventListener('transitionend', handleReset);
              coverArt.style.transition = '';
              coverArt.style.transform = '';
              coverArt.style.opacity = '';
              coverArt.style.willChange = '';
            };
            coverArt.addEventListener('transitionend', handleReset);
            setTimeout(handleReset, 300);
          }
        }

        diffX = 0;
        diffY = 0;
        gestureMode = null;
        if (!isDetermined) {
          expandedPlayer.style.willChange = '';
          if (coverArt) coverArt.style.willChange = '';
        }
      };

      expandedPlayer.addEventListener('touchend', finishExpandedGesture, { passive: true });
      expandedPlayer.addEventListener('touchcancel', finishExpandedGesture, { passive: true });
    },

    // Double-Tap Ripple Feedback Indicator (-10s / +10s)
    triggerDoubleTapFeedback(side) {
      const id = side === 'left' ? 'cover-tap-rewind-indicator' : 'cover-tap-forward-indicator';
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('opacity-0');
      el.classList.add('opacity-100');
      const inner = el.querySelector('div');
      if (inner) {
        inner.classList.remove('scale-90');
        inner.classList.add('scale-105');
      }
      setTimeout(() => {
        el.classList.remove('opacity-100');
        el.classList.add('opacity-0');
        if (inner) {
          inner.classList.remove('scale-105');
          inner.classList.add('scale-90');
        }
      }, 420);
    },

    // 4. MINI-PLAYER BOTTOM BAR GESTURES (SWIPE UP TO EXPAND, SWIPE LEFT/RIGHT TO SKIP)
    initBottomBarGestures() {
      const bottomPlayBar = document.getElementById('bottom-play-bar');
      if (!bottomPlayBar) return;

      let bStartX = 0;
      let bStartY = 0;
      let bDiffX = 0;
      let bDiffY = 0;
      let isBarTracking = false;
      let isBarDetermined = false;
      let isBarSwiping = false;
      let barRafId = null;

      bottomPlayBar.addEventListener('touchstart', (e) => {
        // Ignore touches on playback buttons or inputs
        if (e.target.closest('button, input, a')) return;
        bStartX = e.touches[0].clientX;
        bStartY = e.touches[0].clientY;
        bDiffX = 0;
        bDiffY = 0;
        isBarTracking = true;
        isBarDetermined = false;
        isBarSwiping = false;
        bottomPlayBar.style.willChange = 'transform';
      }, { passive: true });

      bottomPlayBar.addEventListener('touchmove', (e) => {
        if (!isBarTracking) return;
        bDiffX = e.touches[0].clientX - bStartX;
        bDiffY = e.touches[0].clientY - bStartY;
        const absX = Math.abs(bDiffX);
        const absY = Math.abs(bDiffY);

        if (!isBarDetermined && (absX > 8 || absY > 8)) {
          isBarDetermined = true;
          isBarSwiping = true;
          bottomPlayBar.style.transition = 'none';
        }

        if (isBarSwiping) {
          if (e.cancelable) e.preventDefault();

          if (!barRafId) {
            barRafId = requestAnimationFrame(() => {
              barRafId = null;
              if (!isBarTracking || !isBarSwiping) return;
              if (absX > absY) {
                // Subtle horizontal nudge feedback
                bottomPlayBar.style.transform = `translate3d(${bDiffX * 0.22}px, 0, 0)`;
              } else if (bDiffY < 0) {
                // Subtle lift feedback on swipe up
                bottomPlayBar.style.transform = `translate3d(0, ${bDiffY * 0.28}px, 0)`;
              }
            });
          }
        }
      }, { passive: false });

      const finishBottomBarGesture = () => {
        if (barRafId) {
          cancelAnimationFrame(barRafId);
          barRafId = null;
        }
        if (!isBarTracking) return;
        isBarTracking = false;

        bottomPlayBar.style.transition = 'transform 0.22s cubic-bezier(0.175, 0.885, 0.32, 1.15)';
        bottomPlayBar.style.transform = 'translate3d(0, 0, 0)';
        setTimeout(() => {
          bottomPlayBar.style.transition = '';
          bottomPlayBar.style.transform = '';
          bottomPlayBar.style.willChange = '';
        }, 230);

        if (isBarSwiping) {
          // Suppress the click event on bar-expand-trigger
          const suppressClick = (e) => {
            e.stopPropagation();
            e.preventDefault();
          };
          bottomPlayBar.addEventListener('click', suppressClick, { capture: true, once: true });
          setTimeout(() => {
            bottomPlayBar.removeEventListener('click', suppressClick, { capture: true });
          }, 260);

          const absX = Math.abs(bDiffX);
          const absY = Math.abs(bDiffY);

          // 1. Swipe Up -> Expand Player
          if (bDiffY < -35 && absY > absX) {
            if (navigator.vibrate) navigator.vibrate(20);
            if (window.Trove.player && typeof window.Trove.player.expand === 'function') {
              window.Trove.player.expand();
            }
            return;
          }

          // 2. Swipe Left -> Next Track
          if (bDiffX < -40 && absX > absY) {
            if (navigator.vibrate) navigator.vibrate(25);
            if (window.Trove.player) {
              if (typeof window.Trove.player.playNext === 'function') window.Trove.player.playNext();
              else if (typeof window.Trove.player.next === 'function') window.Trove.player.next();
            }
            return;
          }

          // 3. Swipe Right -> Previous Track
          if (bDiffX > 40 && absX > absY) {
            if (navigator.vibrate) navigator.vibrate(25);
            if (window.Trove.player) {
              if (typeof window.Trove.player.playPrev === 'function') window.Trove.player.playPrev();
              else if (typeof window.Trove.player.previous === 'function') window.Trove.player.previous();
            }
            return;
          }
        }
      };

      bottomPlayBar.addEventListener('touchend', finishBottomBarGesture, { passive: true });
      bottomPlayBar.addEventListener('touchcancel', finishBottomBarGesture, { passive: true });
    },

    // 5. QUEUE DRAWER HORIZONTAL SWIPE BETWEEN TABS
    initQueueDrawerGestures() {
      const drawer = document.getElementById('playlists-drawer');
      if (!drawer) return;

      let startX = 0;
      let startY = 0;
      let isDrawerSwipe = false;

      drawer.addEventListener('touchstart', (e) => {
        // Do not intercept on buttons, inputs or scrollbars
        if (e.target.closest('button, input, select, a')) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        isDrawerSwipe = true;
      }, { passive: true });

      drawer.addEventListener('touchend', (e) => {
        if (!isDrawerSwipe) return;
        isDrawerSwipe = false;

        const endX = e.changedTouches[0].clientX;
        const endY = e.changedTouches[0].clientY;
        const diffX = endX - startX;
        const diffY = endY - startY;

        // Needs confident horizontal swipe across tab content
        if (Math.abs(diffX) > 60 && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
          const pm = window.Trove.playlists;
          if (!pm) return;

          if (diffX < 0 && pm.activeTab === 'queue') {
            // Swipe Left -> switch to Playlists
            if (navigator.vibrate) navigator.vibrate(20);
            pm.switchTab('playlists');
          } else if (diffX > 0 && pm.activeTab === 'playlists') {
            // Swipe Right -> switch to Queue
            if (navigator.vibrate) navigator.vibrate(20);
            pm.switchTab('queue');
          }
        }
      }, { passive: true });
    },

    // 6. TRACK CONTEXT ACTION SHEET (LONG-PRESS ACTIONS)
    initContextSheet() {
      const sheet = document.getElementById('track-context-sheet');
      const backdrop = document.getElementById('track-context-backdrop');
      const closeBtn = document.getElementById('context-sheet-close-btn');

      if (backdrop) backdrop.addEventListener('click', () => this.closeContextSheet());
      if (closeBtn) closeBtn.addEventListener('click', () => this.closeContextSheet());

      const btnPlay = document.getElementById('ctx-btn-play');
      const btnPlayNext = document.getElementById('ctx-btn-play-next');
      const btnAddQueue = document.getElementById('ctx-btn-add-queue');
      const btnAddPlaylist = document.getElementById('ctx-btn-add-playlist');
      const btnCopyLink = document.getElementById('ctx-btn-copy-link');

      if (btnPlay) {
        btnPlay.addEventListener('click', () => {
          if (this.contextItem && window.Trove.player) {
            window.Trove.player.playTrack(this.contextItem);
          }
          this.closeContextSheet();
        });
      }

      if (btnPlayNext) {
        btnPlayNext.addEventListener('click', () => {
          if (this.contextItem && window.Trove.playlists) {
            window.Trove.playlists.addToQueue(this.contextItem, true);
          }
          this.closeContextSheet();
        });
      }

      if (btnAddQueue) {
        btnAddQueue.addEventListener('click', () => {
          if (this.contextItem && window.Trove.playlists) {
            window.Trove.playlists.addToQueue(this.contextItem);
          }
          this.closeContextSheet();
        });
      }

      if (btnAddPlaylist) {
        btnAddPlaylist.addEventListener('click', () => {
          const item = this.contextItem;
          this.closeContextSheet();
          if (item && window.Trove.playlists) {
            setTimeout(() => window.Trove.playlists.openAddModal(item), 150);
          }
        });
      }

      if (btnCopyLink) {
        btnCopyLink.addEventListener('click', () => {
          if (this.contextItem) {
            const CONFIG = window.APP_CONFIG || {};
            const repo = CONFIG.repo || {};
            const isBucket = repo.isBucket !== false;
            const baseUrl = isBucket 
              ? `https://huggingface.co/api/buckets/${repo.owner}/${repo.name}/raw/`
              : `https://huggingface.co/datasets/${repo.id}/resolve/main/`;
            const downloadUrl = `${baseUrl}${encodeURIComponent(this.contextItem.path)}`;
            if (navigator.clipboard) {
              navigator.clipboard.writeText(downloadUrl).then(() => {
                if (window.Trove.utils?.showToast) {
                  window.Trove.utils.showToast('Direct download link copied!');
                }
              });
            }
          }
          this.closeContextSheet();
        });
      }
    },

    openContextSheet(item) {
      if (!item) return;
      const sheet = document.getElementById('track-context-sheet');
      const panel = document.getElementById('track-context-panel');
      const title = document.getElementById('context-sheet-title');
      const meta = document.getElementById('context-sheet-meta');
      if (!sheet || !panel) return;

      this.contextItem = item;

      if (title) title.innerText = (item.name || '').replace(/\.[a-zA-Z0-9]+$/, '');
      if (meta) {
        const sizeStr = item.size ? window.Trove.utils?.formatBytes(item.size) : '';
        meta.innerText = `${item.label || 'TRACK'} • ${sizeStr || item.category || 'Audio'}`;
      }

      sheet.style.display = 'flex';
      requestAnimationFrame(() => {
        sheet.classList.remove('opacity-0', 'pointer-events-none');
        sheet.classList.add('opacity-100', 'pointer-events-auto');
        panel.classList.remove('translate-y-full');
        panel.classList.add('translate-y-0');
      });
      if (window.lucide) window.lucide.createIcons();
    },

    closeContextSheet() {
      const sheet = document.getElementById('track-context-sheet');
      const panel = document.getElementById('track-context-panel');
      if (!sheet || !panel) return;

      panel.classList.remove('translate-y-0');
      panel.classList.add('translate-y-full');
      sheet.classList.remove('opacity-100', 'pointer-events-auto');
      sheet.classList.add('opacity-0', 'pointer-events-none');

      setTimeout(() => {
        sheet.style.display = 'none';
        this.contextItem = null;
      }, 250);
    }
  };

  // Export & Auto-init on DOMContentLoaded
  window.Trove.gestures = GesturesManager;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => GesturesManager.init());
  } else {
    GesturesManager.init();
  }
})();
