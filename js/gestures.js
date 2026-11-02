/**
 * Trove Media Vault - Native Mobile Touch Gestures Engine
 *
 * Implements 60/120fps hardware-accelerated gestures with authentic spring physics:
 *   1. Pull-Down to Refresh (Vault Explorer #file-list) with natural logarithmic rubber-band
 *   2. Swipe Track Right to Add to Queue (Revealing green action underlayer with dynamic icon scale)
 *   3. Expanded Player Sheet: Fluid drag down to dismiss (with scale & radius, zero duplicated animation)
 *   4. Expanded Player Artwork: Horizontal swipe with 3D rotational tilt, instant base fallback, and smooth spring entry
 *   5. Mini-Player Bottom Bar: Swipe up to expand, swipe left/right to skip with click suppression
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
      const THRESHOLD = 65;

      fileList.addEventListener('touchstart', (e) => {
        if (this.isRefreshing) return;
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

        // Disambiguate downward pull from horizontal scroll
        if (diffY > 6 && Math.abs(diffY) > Math.abs(diffX) * 1.3) {
          isPulling = true;
          // Organic logarithmic rubber-band damping
          pullDistance = Math.min(95, Math.pow(diffY, 0.82) * 1.6);

          if (e.cancelable) e.preventDefault();

          indicator.style.transition = 'none';
          indicator.style.opacity = `${Math.min(1, pullDistance / 40)}`;
          indicator.style.transform = `translate3d(-50%, ${pullDistance - 38}px, 0)`;

          if (icon) {
            const rot = (pullDistance / THRESHOLD) * 360;
            icon.style.transform = `rotate(${rot}deg)`;
          }

          if (text) {
            if (pullDistance >= THRESHOLD) {
              text.innerText = 'Release to refresh';
              indicator.classList.add('border-emerald-500/50', 'bg-emerald-50/95', 'dark:bg-emerald-950/95');
            } else {
              text.innerText = 'Pull to refresh';
              indicator.classList.remove('border-emerald-500/50', 'bg-emerald-50/95', 'dark:bg-emerald-950/95');
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
                  this.isRefreshing = false;
                  if (window.lucide) window.lucide.createIcons();
                }, 250);
              }, 400);
            });
          } else {
            this.isRefreshing = false;
          }
        } else {
          indicator.style.transition = 'transform 0.24s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.2s ease-out';
          indicator.style.transform = 'translate3d(-50%, -48px, 0)';
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
      let activeBadge = null;
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
          activeBadge = null;
          return;
        }

        // Avoid swiping if touching quick action button
        if (e.target.closest('.btn-add-to-playlist')) return;

        activeRow = row;
        const wrapper = row.closest('.file-row-wrapper');
        activeReveal = wrapper ? wrapper.querySelector('.swipe-queue-reveal') : null;
        activeBadge = activeReveal ? activeReveal.querySelector('div') : null;

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

        // Disambiguate within first 8px
        if (!isDetermined && (Math.abs(diffX) > 8 || Math.abs(diffY) > 8)) {
          isDetermined = true;
          if (diffX > 8 && Math.abs(diffX) > Math.abs(diffY) * 1.3) {
            isHorizontal = true;
            this.isSwipingRow = true;
            activeRow.classList.add('select-none');

            // Fallback: If underlayer missing, inject dynamically
            if (!activeReveal && activeRow.parentElement) {
              const underlayer = document.createElement('div');
              underlayer.className = 'swipe-queue-reveal absolute inset-y-0 left-0 w-full bg-emerald-600 dark:bg-emerald-600 flex items-center px-4 text-white font-semibold text-xs select-none pointer-events-none transition-colors';
              underlayer.innerHTML = `
                <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/20 backdrop-blur-xs shadow-xs transition-transform duration-150">
                  <svg class="w-4 h-4 shrink-0 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 12H3"/><path d="M16 6H3"/><path d="M16 18H3"/><path d="M18 9v6"/><path d="M21 12h-6"/></svg>
                  <span class="tracking-wider text-[11px] font-bold uppercase text-white">Add to Queue</span>
                </div>
              `;
              activeRow.parentElement.insertBefore(underlayer, activeRow);
              activeReveal = underlayer;
              activeBadge = underlayer.querySelector('div');
            }
          } else {
            isHorizontal = false;
            activeRow = null;
            activeReveal = null;
            activeBadge = null;
            return;
          }
        }

        if (isHorizontal && diffX > 0) {
          if (e.cancelable) e.preventDefault();
          // Progressive rubber-band travel
          currentDeltaX = diffX > 80 ? 80 + (diffX - 80) * 0.35 : diffX;
          activeRow.style.transition = 'none';
          activeRow.style.transform = `translate3d(${currentDeltaX}px, 0, 0)`;

          // Visual cue & dynamic badge scaling
          if (activeReveal) {
            const scale = Math.min(1.08, 0.8 + (currentDeltaX / SWIPE_THRESHOLD) * 0.28);
            if (activeBadge) activeBadge.style.transform = `scale(${scale})`;

            if (currentDeltaX >= SWIPE_THRESHOLD) {
              activeReveal.classList.remove('bg-emerald-600', 'dark:bg-emerald-600');
              activeReveal.classList.add('bg-emerald-500', 'dark:bg-emerald-500');
              if (activeBadge) activeBadge.classList.add('bg-white/30');
            } else {
              activeReveal.classList.add('bg-emerald-600', 'dark:bg-emerald-600');
              activeReveal.classList.remove('bg-emerald-500', 'dark:bg-emerald-500');
              if (activeBadge) activeBadge.classList.remove('bg-white/30');
            }
          }
        }
      }, { passive: false });

      const endRowSwipe = () => {
        if (!activeRow) return;

        const row = activeRow;
        const reveal = activeReveal;
        const badge = activeBadge;
        activeRow = null;
        activeReveal = null;
        activeBadge = null;

        if (isHorizontal && currentDeltaX >= SWIPE_THRESHOLD) {
          if (navigator.vibrate) navigator.vibrate(30);

          const filePath = row.dataset.path;
          const state = window.Trove.state || {};
          const item = (state.allItems || []).find(i => i.path === filePath);

          if (item && window.Trove.playlists && typeof window.Trove.playlists.addToQueue === 'function') {
            window.Trove.playlists.addToQueue(item);
          }
        }

        // Tactile spring return
        row.style.transition = 'transform 0.28s cubic-bezier(0.175, 0.885, 0.32, 1.15)';
        row.style.transform = 'translate3d(0, 0, 0)';
        setTimeout(() => {
          row.style.transition = '';
          row.style.transform = '';
          row.classList.remove('select-none');
          if (reveal) {
            reveal.classList.add('bg-emerald-600', 'dark:bg-emerald-600');
            reveal.classList.remove('bg-emerald-500', 'dark:bg-emerald-500');
            if (badge) {
              badge.style.transform = '';
              badge.classList.remove('bg-white/30');
            }
          }
          setTimeout(() => {
            this.isSwipingRow = false;
          }, 80);
        }, 290);
      };

      fileList.addEventListener('touchend', endRowSwipe, { passive: true });
      fileList.addEventListener('touchcancel', endRowSwipe, { passive: true });

      // Suppress clicks on rows if user just swiped
      fileList.addEventListener('click', (e) => {
        if (this.isSwipingRow) {
          e.stopPropagation();
          e.preventDefault();
        }
      }, true);
    },

    // 3. EXPANDED PLAYER GESTURES (DRAG DOWN TO MINIMIZE & HORIZONTAL SWIPE TO SKIP)
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
          } else if (absX > 8 && absX > absY * 1.1) {
            // Horizontal swipe to skip track
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
            // Fluid downward sheet movement with dynamic micro-scale & corner-radius
            const pullDown = diffY * 0.85;
            const scale = Math.max(0.93, 1 - (pullDown / 2500));
            expandedPlayer.style.transition = 'none';
            expandedPlayer.style.transform = `translate3d(0, ${pullDown}px, 0) scale(${scale})`;
            expandedPlayer.style.borderRadius = `${Math.min(28, (pullDown / 100) * 28)}px`;
            const opacity = Math.max(0.72, 1 - (pullDown / 650));
            expandedPlayer.style.opacity = `${opacity}`;
          }
        } else if (gestureMode === 'horizontal') {
          if (e.cancelable) e.preventDefault();
          // Visual horizontal travel with subtle 3D rotational tilt on cover art
          if (coverArt) {
            const travelX = diffX * 0.65;
            const tilt = (diffX / 300) * 7;
            coverArt.style.transition = 'none';
            coverArt.style.transform = `translate3d(${travelX}px, 0, 0) rotate(${tilt}deg)`;
            const fade = Math.max(0.45, 1 - (absX / 320));
            coverArt.style.opacity = `${fade}`;
          }
        }
      }, { passive: false });

      const finishExpandedGesture = () => {
        if (!isTracking) return;
        isTracking = false;

        if (gestureMode === 'down') {
          const THRESHOLD_MINIMIZE = 80;
          if (diffY >= THRESHOLD_MINIMIZE) {
            if (navigator.vibrate) navigator.vibrate(20);
            // Single, clean dismissal: animate directly off-screen
            expandedPlayer.style.transition = 'transform 0.24s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.2s ease-out';
            expandedPlayer.style.transform = 'translate3d(0, 100%, 0) scale(0.9)';
            expandedPlayer.style.opacity = '0';
            setTimeout(() => {
              // Pass skipAnimation = true so player.minimize does NOT replay duplicate animation!
              if (window.Trove.player && typeof window.Trove.player.minimize === 'function') {
                window.Trove.player.minimize(true);
              }
            }, 230);
          } else {
            // Elastic spring back to fullscreen
            expandedPlayer.style.transition = 'transform 0.28s cubic-bezier(0.175, 0.885, 0.32, 1.1), opacity 0.22s ease-out';
            expandedPlayer.style.transform = 'translate3d(0, 0, 0) scale(1)';
            expandedPlayer.style.opacity = '1';
            expandedPlayer.style.borderRadius = '';
            setTimeout(() => {
              expandedPlayer.style.transition = '';
            }, 290);
          }
        } else if (gestureMode === 'horizontal') {
          const THRESHOLD_SKIP = 48;
          const absX = Math.abs(diffX);

          if (absX >= THRESHOLD_SKIP) {
            if (navigator.vibrate) navigator.vibrate(25);
            const isNext = diffX < 0; // Swipe Left = Next, Swipe Right = Previous

            if (coverArt) {
              // Slide out in swipe direction with slight tilt
              coverArt.style.transition = 'transform 0.18s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.15s ease-out';
              coverArt.style.transform = `translate3d(${isNext ? -130 : 130}px, 0, 0) rotate(${isNext ? -12 : 12}deg)`;
              coverArt.style.opacity = '0';

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
                // Prepare entry from opposite side with scale
                coverArt.style.transition = 'none';
                coverArt.style.transform = `translate3d(${isNext ? 90 : -90}px, 0, 0) rotate(${isNext ? 8 : -8}deg) scale(0.93)`;
                coverArt.style.opacity = '0.3';

                requestAnimationFrame(() => {
                  coverArt.style.transition = 'transform 0.32s cubic-bezier(0.175, 0.885, 0.32, 1.1), opacity 0.26s ease-out';
                  coverArt.style.transform = 'translate3d(0, 0, 0) rotate(0deg) scale(1)';
                  coverArt.style.opacity = '1';
                  setTimeout(() => {
                    coverArt.style.transition = '';
                    coverArt.style.transform = '';
                    coverArt.style.opacity = '';
                  }, 330);
                });
              }, 170);
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
            // Spring back to center
            coverArt.style.transition = 'transform 0.26s cubic-bezier(0.175, 0.885, 0.32, 1.15), opacity 0.2s ease-out';
            coverArt.style.transform = 'translate3d(0, 0, 0) rotate(0deg) scale(1)';
            coverArt.style.opacity = '1';
            setTimeout(() => {
              coverArt.style.transition = '';
              coverArt.style.transform = '';
              coverArt.style.opacity = '';
            }, 270);
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
            bottomPlayBar.style.transform = `translate3d(${bDiffX * 0.22}px, 0, 0)`;
          } else if (bDiffY < 0) {
            if (e.cancelable) e.preventDefault();
            // Subtle lift feedback on swipe up
            bottomPlayBar.style.transform = `translate3d(0, ${bDiffY * 0.28}px, 0)`;
          }
        }
      }, { passive: false });

      const finishBottomBarGesture = () => {
        if (!isBarTracking) return;
        isBarTracking = false;

        bottomPlayBar.style.transition = 'transform 0.24s cubic-bezier(0.175, 0.885, 0.32, 1.15)';
        bottomPlayBar.style.transform = 'translate3d(0, 0, 0)';
        setTimeout(() => {
          bottomPlayBar.style.transition = '';
          bottomPlayBar.style.transform = '';
        }, 250);

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