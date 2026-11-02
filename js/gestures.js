/**
 * Trove Media Vault - Native Mobile Touch Gestures Engine
 *
 * Implements 60/120fps hardware-accelerated gestures without external dependencies:
 *   1. Pull-Down to Refresh (Vault Explorer #file-list)
 *   2. Swipe Track Right to Add to Queue (Revealing green action underlayer with icon)
 *   3. Expanded Player Gestures (Drag down to minimize, swipe left/right to skip tracks)
 *   4. Mini-Player Bar Gestures (Swipe up to expand, swipe left/right to skip tracks)
 */
(function() {
  window.Trove = window.Trove || {};

  const GesturesManager = {
    isRefreshing: false,
    isSwipingRow: false,

    init() {
      this.initPullToRefresh();
      this.initRowSwipeToQueue();
      this.initExpandedPlayerGestures();
      this.initBottomBarGestures();
    },

    // 1. PULL-DOWN TO REFRESH
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
      const THRESHOLD = 65;

      fileList.addEventListener('touchstart', (e) => {
        if (this.isRefreshing) return;
        // Only engage when scrolled to the very top
        if (fileList.scrollTop <= 0) {
          startY = e.touches[0].clientY;
          startX = e.touches[0].clientX;
          isPulling = false;
          pullDistance = 0;
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

        // If user is pulling downward and mostly vertical
        if (diffY > 5 && Math.abs(diffY) > Math.abs(diffX) * 1.2) {
          isPulling = true;
          // Apply rubber-band damping
          pullDistance = Math.min(diffY * 0.42, 95);

          if (e.cancelable) e.preventDefault();

          indicator.style.transition = 'none';
          indicator.style.opacity = `${Math.min(1, pullDistance / 35)}`;
          indicator.style.transform = `translate(-50%, ${pullDistance - 35}px)`;

          if (icon) {
            const rot = (pullDistance / THRESHOLD) * 360;
            icon.style.transform = `rotate(${rot}deg)`;
          }

          if (text) {
            if (pullDistance >= THRESHOLD) {
              text.innerText = 'Release to refresh';
              indicator.classList.add('border-emerald-500/50', 'bg-emerald-50/90', 'dark:bg-emerald-950/90');
            } else {
              text.innerText = 'Pull to refresh';
              indicator.classList.remove('border-emerald-500/50', 'bg-emerald-50/90', 'dark:bg-emerald-950/90');
            }
          }
        }
      }, { passive: false });

      const finishPull = () => {
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
          indicator.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
          indicator.style.transform = 'translate(-50%, 25px)';
          indicator.style.opacity = '1';

          if (window.Trove.explorer && typeof window.Trove.explorer.loadRepository === 'function') {
            window.Trove.explorer.loadRepository(true).finally(() => {
              setTimeout(() => {
                indicator.style.transition = 'transform 0.25s ease-in, opacity 0.25s ease-in';
                indicator.style.transform = 'translate(-50%, -48px)';
                indicator.style.opacity = '0';
                setTimeout(() => {
                  if (icon) icon.classList.remove('animate-spin');
                  indicator.classList.remove('border-emerald-500/50', 'bg-emerald-50/90', 'dark:bg-emerald-950/90');
                  this.isRefreshing = false;
                  if (window.lucide) window.lucide.createIcons();
                }, 250);
              }, 400);
            });
          } else {
            this.isRefreshing = false;
          }
        } else {
          indicator.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
          indicator.style.transform = 'translate(-50%, -48px)';
          indicator.style.opacity = '0';
        }
        pullDistance = 0;
      };

      fileList.addEventListener('touchend', finishPull, { passive: true });
      fileList.addEventListener('touchcancel', finishPull, { passive: true });
    },

    // 2. SWIPE TRACK RIGHT TO ADD TO QUEUE
    initRowSwipeToQueue() {
      const fileList = document.getElementById('file-list');
      if (!fileList) return;

      let activeRow = null;
      let activeReveal = null;
      let startX = 0;
      let startY = 0;
      let isHorizontal = false;
      let isDetermined = false;
      let currentDeltaX = 0;
      const SWIPE_THRESHOLD = 75;

      fileList.addEventListener('touchstart', (e) => {
        const row = e.target.closest('.file-row');
        if (!row || row.dataset.isDir === 'true') {
          activeRow = null;
          activeReveal = null;
          return;
        }

        // Avoid swiping if touching quick action button
        if (e.target.closest('.btn-add-to-playlist')) return;

        activeRow = row;
        const wrapper = row.closest('.file-row-wrapper');
        activeReveal = wrapper ? wrapper.querySelector('.swipe-queue-reveal') : null;

        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        isHorizontal = false;
        isDetermined = false;
        currentDeltaX = 0;
        this.isSwipingRow = false;
      }, { passive: true });

      fileList.addEventListener('touchmove', (e) => {
        if (!activeRow) return;

        const currentX = e.touches[0].clientX;
        const currentY = e.touches[0].clientY;
        const diffX = currentX - startX;
        const diffY = currentY - startY;

        // Determine direction in first 10px
        if (!isDetermined && (Math.abs(diffX) > 8 || Math.abs(diffY) > 8)) {
          isDetermined = true;
          // Swiping right?
          if (diffX > 8 && Math.abs(diffX) > Math.abs(diffY) * 1.2) {
            isHorizontal = true;
            this.isSwipingRow = true;
            activeRow.classList.add('select-none');

            // Fallback: If underlayer missing, inject dynamically
            if (!activeReveal && activeRow.parentElement) {
              const underlayer = document.createElement('div');
              underlayer.className = 'swipe-queue-reveal absolute inset-y-0 left-0 w-full bg-emerald-600 dark:bg-emerald-600 flex items-center px-4 text-white font-semibold text-xs select-none pointer-events-none transition-colors';
              underlayer.innerHTML = `
                <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/20 backdrop-blur-xs shadow-xs">
                  <svg class="w-4 h-4 shrink-0 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 12H3"/><path d="M16 6H3"/><path d="M16 18H3"/><path d="M18 9v6"/><path d="M21 12h-6"/></svg>
                  <span class="tracking-wider text-[11px] font-bold uppercase text-white">Add to Queue</span>
                </div>
              `;
              activeRow.parentElement.insertBefore(underlayer, activeRow);
              activeReveal = underlayer;
            }
          } else {
            isHorizontal = false;
            activeRow = null;
            activeReveal = null;
            return;
          }
        }

        if (isHorizontal && diffX > 0) {
          if (e.cancelable) e.preventDefault();
          // Rubber band effect beyond 125px
          currentDeltaX = diffX > 125 ? 125 + (diffX - 125) * 0.28 : diffX;
          activeRow.style.transition = 'none';
          activeRow.style.transform = `translateX(${currentDeltaX}px)`;

          // Visual cue when threshold crossed
          if (activeReveal) {
            const badge = activeReveal.querySelector('div');
            if (currentDeltaX >= SWIPE_THRESHOLD) {
              activeReveal.classList.remove('bg-emerald-600', 'dark:bg-emerald-600');
              activeReveal.classList.add('bg-emerald-500', 'dark:bg-emerald-500');
              if (badge) badge.classList.add('scale-105', 'bg-white/30');
            } else {
              activeReveal.classList.add('bg-emerald-600', 'dark:bg-emerald-600');
              activeReveal.classList.remove('bg-emerald-500', 'dark:bg-emerald-500');
              if (badge) badge.classList.remove('scale-105', 'bg-white/30');
            }
          }
        }
      }, { passive: false });

      const endRowSwipe = () => {
        if (!activeRow) return;

        const row = activeRow;
        const reveal = activeReveal;
        activeRow = null;
        activeReveal = null;

        if (isHorizontal && currentDeltaX >= SWIPE_THRESHOLD) {
          if (navigator.vibrate) navigator.vibrate(30);

          const filePath = row.dataset.path;
          const state = window.Trove.state || {};
          const item = (state.allItems || []).find(i => i.path === filePath);

          if (item && window.Trove.playlists && typeof window.Trove.playlists.addToQueue === 'function') {
            window.Trove.playlists.addToQueue(item);
          }
        }

        // Animate row back smoothly
        row.style.transition = 'transform 0.24s cubic-bezier(0.2, 0.9, 0.3, 1)';
        row.style.transform = 'translateX(0)';
        setTimeout(() => {
          row.style.transition = '';
          row.style.transform = '';
          row.classList.remove('select-none');
          if (reveal) {
            reveal.classList.add('bg-emerald-600', 'dark:bg-emerald-600');
            reveal.classList.remove('bg-emerald-500', 'dark:bg-emerald-500');
            const badge = reveal.querySelector('div');
            if (badge) badge.classList.remove('scale-105', 'bg-white/30');
          }
          setTimeout(() => {
            this.isSwipingRow = false;
          }, 80);
        }, 250);
      };

      fileList.addEventListener('touchend', endRowSwipe, { passive: true });
      fileList.addEventListener('touchcancel', endRowSwipe, { passive: true });

      // Intercept clicks on rows if user just swiped
      fileList.addEventListener('click', (e) => {
        if (this.isSwipingRow) {
          e.stopPropagation();
          e.preventDefault();
        }
      }, true);
    },

    // 3. EXPANDED PLAYER GESTURES (SWIPE DOWN TO MINIMIZE, SWIPE LEFT/RIGHT TO SKIP)
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

      expandedPlayer.addEventListener('touchstart', (e) => {
        // Only active when player is actually expanded
        const playerState = window.Trove.player || {};
        if (playerState.isExpanded === false) return;

        // Ignore touches on interactive controls (buttons, range sliders, select, lyrics scrolling)
        if (e.target.closest('button, input, select, a, #lyrics-scroll-body, #expanded-lyrics-container')) return;

        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        diffX = 0;
        diffY = 0;
        isTracking = true;
        gestureMode = null;
        isDetermined = false;
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
          // Downward drag to minimize
          if (diffY > 8 && diffY > absX * 0.9) {
            gestureMode = 'down';
          } else if (absX > 8 && absX > absY * 0.9) {
            // Horizontal swipe to skip
            gestureMode = 'horizontal';
          } else {
            gestureMode = null;
            isTracking = false;
            return;
          }
        }

        if (gestureMode === 'down') {
          if (diffY > 0) {
            if (e.cancelable) e.preventDefault();
            // Fluid downward sheet movement with rubber-band damping
            expandedPlayer.style.transition = 'none';
            expandedPlayer.style.transform = `translateY(${diffY}px)`;
            const opacity = Math.max(0.65, 1 - (diffY / 550));
            expandedPlayer.style.opacity = `${opacity}`;
          }
        } else if (gestureMode === 'horizontal') {
          if (e.cancelable) e.preventDefault();
          // Visual horizontal drag feedback on the album cover art
          if (coverArt) {
            coverArt.style.transition = 'none';
            coverArt.style.transform = `translateX(${diffX * 0.45}px)`;
            const fade = Math.max(0.4, 1 - (absX / 280));
            coverArt.style.opacity = `${fade}`;
          }
        }
      }, { passive: false });

      const finishExpandedGesture = () => {
        if (!isTracking) return;
        isTracking = false;

        if (gestureMode === 'down') {
          const THRESHOLD_MINIMIZE = 85;
          if (diffY >= THRESHOLD_MINIMIZE) {
            if (navigator.vibrate) navigator.vibrate(20);
            // Animate sheet sliding away smoothly
            expandedPlayer.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.22s ease';
            expandedPlayer.style.transform = 'translateY(100%)';
            expandedPlayer.style.opacity = '0';
            setTimeout(() => {
              expandedPlayer.style.transition = '';
              expandedPlayer.style.transform = '';
              expandedPlayer.style.opacity = '';
              if (window.Trove.player && typeof window.Trove.player.minimize === 'function') {
                window.Trove.player.minimize();
              }
            }, 210);
          } else {
            // Snap back up
            expandedPlayer.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.22s ease';
            expandedPlayer.style.transform = 'translateY(0%)';
            expandedPlayer.style.opacity = '1';
            setTimeout(() => {
              expandedPlayer.style.transition = '';
              expandedPlayer.style.transform = '';
              expandedPlayer.style.opacity = '';
            }, 230);
          }
        } else if (gestureMode === 'horizontal') {
          const THRESHOLD_SKIP = 48;
          const absX = Math.abs(diffX);

          if (absX >= THRESHOLD_SKIP) {
            if (navigator.vibrate) navigator.vibrate(25);
            const isNext = diffX < 0; // Swipe Left = Next, Swipe Right = Previous

            if (coverArt) {
              // Slide out in swipe direction
              coverArt.style.transition = 'transform 0.16s ease-out, opacity 0.16s ease-out';
              coverArt.style.transform = `translateX(${isNext ? -90 : 90}px)`;
              coverArt.style.opacity = '0.1';

              setTimeout(() => {
                if (window.Trove.player) {
                  if (isNext) {
                    if (typeof window.Trove.player.playNext === 'function') window.Trove.player.playNext();
                    else if (typeof window.Trove.player.next === 'function') window.Trove.player.next();
                  } else {
                    if (typeof window.Trove.player.playPrev === 'function') window.Trove.player.playPrev();
                    else if (typeof window.Trove.player.previous === 'function') window.Trove.player.previous();
                  }
                }
                // Prepare slide in from opposite side
                coverArt.style.transition = 'none';
                coverArt.style.transform = `translateX(${isNext ? 90 : -90}px)`;
                coverArt.style.opacity = '0.2';

                requestAnimationFrame(() => {
                  coverArt.style.transition = 'transform 0.24s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.24s ease';
                  coverArt.style.transform = 'translateX(0)';
                  coverArt.style.opacity = '1';
                  setTimeout(() => {
                    coverArt.style.transition = '';
                    coverArt.style.transform = '';
                    coverArt.style.opacity = '';
                  }, 250);
                });
              }, 160);
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
            // Snap cover back to center
            coverArt.style.transition = 'transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.2s ease';
            coverArt.style.transform = 'translateX(0)';
            coverArt.style.opacity = '1';
            setTimeout(() => {
              coverArt.style.transition = '';
              coverArt.style.transform = '';
              coverArt.style.opacity = '';
            }, 210);
          }
        }

        diffX = 0;
        diffY = 0;
        gestureMode = null;
      };

      expandedPlayer.addEventListener('touchend', finishExpandedGesture, { passive: true });
      expandedPlayer.addEventListener('touchcancel', finishExpandedGesture, { passive: true });
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
        }

        if (isBarSwiping) {
          if (absX > absY) {
            if (e.cancelable) e.preventDefault();
            // Subtle horizontal nudge feedback
            bottomPlayBar.style.transform = `translateX(${bDiffX * 0.22}px)`;
          } else if (bDiffY < 0) {
            if (e.cancelable) e.preventDefault();
            // Subtle lift feedback on swipe up
            bottomPlayBar.style.transform = `translateY(${bDiffY * 0.3}px)`;
          }
        }
      }, { passive: false });

      const finishBottomBarGesture = () => {
        if (!isBarTracking) return;
        isBarTracking = false;

        bottomPlayBar.style.transition = 'transform 0.22s ease-out';
        bottomPlayBar.style.transform = '';
        setTimeout(() => {
          bottomPlayBar.style.transition = '';
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
          }, 250);

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