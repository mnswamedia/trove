/**
 * Trove Media Vault - Native Mobile Touch Gestures Engine
 *
 * Implements 60/120fps hardware-accelerated gestures without external dependencies:
 *   1. Pull-Down to Refresh (Vault Explorer)
 *   2. Swipe Track Right to Add to Queue (File Rows)
 *   3. Swipe Player to Skip & Minimize (Expanded Artwork + Mini-Player Bar)
 */
(function() {
  window.Trove = window.Trove || {};

  const GesturesManager = {
    isRefreshing: false,
    isSwipingRow: false,

    init() {
      this.initPullToRefresh();
      this.initRowSwipeToQueue();
      this.initPlayerGestures();
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
      let startX = 0;
      let startY = 0;
      let isHorizontal = false;
      let isDetermined = false;
      let currentDeltaX = 0;
      const SWIPE_THRESHOLD = 70;

      fileList.addEventListener('touchstart', (e) => {
        const row = e.target.closest('.file-row');
        if (!row || row.dataset.isDir === 'true') {
          activeRow = null;
          return;
        }

        // Avoid swiping if touching quick action button
        if (e.target.closest('.btn-add-to-playlist')) return;

        activeRow = row;
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
          } else {
            isHorizontal = false;
            activeRow = null;
            return;
          }
        }

        if (isHorizontal && diffX > 0) {
          if (e.cancelable) e.preventDefault();
          currentDeltaX = Math.min(diffX, 110);
          activeRow.style.transition = 'none';
          activeRow.style.transform = `translateX(${currentDeltaX}px)`;

          // Visual cue when threshold crossed
          if (currentDeltaX >= SWIPE_THRESHOLD) {
            activeRow.classList.add('bg-emerald-50/70', 'dark:bg-emerald-950/40');
          } else {
            activeRow.classList.remove('bg-emerald-50/70', 'dark:bg-emerald-950/40');
          }
        }
      }, { passive: false });

      const endRowSwipe = () => {
        if (!activeRow) return;

        const row = activeRow;
        activeRow = null;

        if (isHorizontal && currentDeltaX >= SWIPE_THRESHOLD) {
          if (navigator.vibrate) navigator.vibrate(30);

          const filePath = row.dataset.path;
          const state = window.Trove.state || {};
          const item = (state.allItems || []).find(i => i.path === filePath);

          if (item && window.Trove.playlists && typeof window.Trove.playlists.addToQueue === 'function') {
            window.Trove.playlists.addToQueue(item);
            if (window.Trove.utils && window.Trove.utils.showToast) {
              window.Trove.utils.showToast(`Added "${item.name}" to queue`);
            }
          }
        }

        // Animate row back smoothly
        row.style.transition = 'transform 0.24s cubic-bezier(0.2, 0.9, 0.3, 1), background-color 0.24s ease';
        row.style.transform = 'translateX(0)';
        setTimeout(() => {
          row.style.transition = '';
          row.style.transform = '';
          row.classList.remove('bg-emerald-50/70', 'dark:bg-emerald-950/40', 'select-none');
          // Reset swiping state shortly after to block accidental row click
          setTimeout(() => {
            this.isSwipingRow = false;
          }, 60);
        }, 240);
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

    // 3. SWIPE PLAYER TO SKIP / MINIMIZE
    initPlayerGestures() {
      // A. Expanded Player Artwork & Stage
      const expandedPlayer = document.getElementById('expanded-player');
      const stageMusic = document.getElementById('stage-music');
      const coverArt = document.getElementById('expanded-cover-art');

      if (expandedPlayer && (coverArt || stageMusic)) {
        const targetStage = coverArt || stageMusic;
        let startX = 0;
        let startY = 0;
        let diffX = 0;
        let diffY = 0;
        let isMoving = false;

        targetStage.addEventListener('touchstart', (e) => {
          // Don't intercept if touching interactive controls
          if (e.target.closest('button, input, a, select')) return;
          startX = e.touches[0].clientX;
          startY = e.touches[0].clientY;
          diffX = 0;
          diffY = 0;
          isMoving = true;
        }, { passive: true });

        targetStage.addEventListener('touchmove', (e) => {
          if (!isMoving) return;
          diffX = e.touches[0].clientX - startX;
          diffY = e.touches[0].clientY - startY;

          // Drag down on player stage gives slight pull feedback
          if (diffY > 15 && Math.abs(diffY) > Math.abs(diffX)) {
            if (e.cancelable) e.preventDefault();
          }
        }, { passive: false });

        const endStageGesture = () => {
          if (!isMoving) return;
          isMoving = false;

          const absX = Math.abs(diffX);
          const absY = Math.abs(diffY);

          // 1. Vertical Swipe Down -> Minimize Player
          if (diffY > 70 && absY > absX * 1.2) {
            if (navigator.vibrate) navigator.vibrate(20);
            if (window.Trove.player && typeof window.Trove.player.minimize === 'function') {
              window.Trove.player.minimize();
            }
            return;
          }

          // 2. Horizontal Swipe -> Next / Previous
          if (absX >= 55 && absX > absY) {
            if (navigator.vibrate) navigator.vibrate(25);
            if (diffX < 0) {
              // Swipe Left -> Next
              if (coverArt) {
                coverArt.style.transition = 'transform 0.15s ease-out, opacity 0.15s ease-out';
                coverArt.style.transform = 'translateX(-30px)';
                coverArt.style.opacity = '0.7';
                setTimeout(() => {
                  coverArt.style.transform = 'translateX(20px)';
                  if (window.Trove.player) window.Trove.player.next();
                  setTimeout(() => {
                    coverArt.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
                    coverArt.style.transform = 'translateX(0)';
                    coverArt.style.opacity = '1';
                  }, 40);
                }, 150);
              } else if (window.Trove.player) {
                window.Trove.player.next();
              }
            } else {
              // Swipe Right -> Previous
              if (coverArt) {
                coverArt.style.transition = 'transform 0.15s ease-out, opacity 0.15s ease-out';
                coverArt.style.transform = 'translateX(30px)';
                coverArt.style.opacity = '0.7';
                setTimeout(() => {
                  coverArt.style.transform = 'translateX(-20px)';
                  if (window.Trove.player) window.Trove.player.previous();
                  setTimeout(() => {
                    coverArt.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
                    coverArt.style.transform = 'translateX(0)';
                    coverArt.style.opacity = '1';
                  }, 40);
                }, 150);
              } else if (window.Trove.player) {
                window.Trove.player.previous();
              }
            }
          }
        };

        targetStage.addEventListener('touchend', endStageGesture, { passive: true });
        targetStage.addEventListener('touchcancel', endStageGesture, { passive: true });
      }

      // B. Mini-Player Bottom Bar (Swipe left/right to skip, swipe up to expand)
      const bottomPlayBar = document.getElementById('bottom-play-bar');
      if (bottomPlayBar) {
        let bStartX = 0;
        let bStartY = 0;
        let bDiffX = 0;
        let bDiffY = 0;
        let bMoving = false;

        bottomPlayBar.addEventListener('touchstart', (e) => {
          // Ignore touches on actual buttons
          if (e.target.closest('button, input, a')) return;
          bStartX = e.touches[0].clientX;
          bStartY = e.touches[0].clientY;
          bDiffX = 0;
          bDiffY = 0;
          bMoving = true;
        }, { passive: true });

        bottomPlayBar.addEventListener('touchmove', (e) => {
          if (!bMoving) return;
          bDiffX = e.touches[0].clientX - bStartX;
          bDiffY = e.touches[0].clientY - bStartY;
        }, { passive: true });

        const endBottomBarGesture = () => {
          if (!bMoving) return;
          bMoving = false;

          const absX = Math.abs(bDiffX);
          const absY = Math.abs(bDiffY);

          // 1. Swipe Up -> Expand Player
          if (bDiffY < -40 && absY > absX) {
            if (navigator.vibrate) navigator.vibrate(20);
            if (window.Trove.player && typeof window.Trove.player.expand === 'function') {
              window.Trove.player.expand();
            }
            return;
          }

          // 2. Swipe Left -> Next
          if (bDiffX < -45 && absX > absY) {
            if (navigator.vibrate) navigator.vibrate(25);
            if (window.Trove.player && typeof window.Trove.player.next === 'function') {
              window.Trove.player.next();
            }
            return;
          }

          // 3. Swipe Right -> Previous
          if (bDiffX > 45 && absX > absY) {
            if (navigator.vibrate) navigator.vibrate(25);
            if (window.Trove.player && typeof window.Trove.player.previous === 'function') {
              window.Trove.player.previous();
            }
            return;
          }
        };

        bottomPlayBar.addEventListener('touchend', endBottomBarGesture, { passive: true });
        bottomPlayBar.addEventListener('touchcancel', endBottomBarGesture, { passive: true });
      }
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

