/**
 * Trove Media Vault - Application Entry Point & Orchestrator
 * Coordinates modules, theme management, keyboard shortcuts, history back-navigation, and PWA lifecycle.
 */
(function() {
  window.Trove = window.Trove || {};

  const CONFIG = window.APP_CONFIG || {};
  const repo = CONFIG.repo || {};
  const { MotionAnim, showExitToast } = window.Trove.utils || {};

  // Theme Management (Light / Dark)
  function initTheme() {
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    const mobileThemeToggle = document.getElementById('mobile-theme-btn');
    const savedTheme = localStorage.getItem('trove_theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = savedTheme === 'dark' || (!savedTheme && prefersDark);
    applyTheme(isDark ? 'dark' : 'light');

    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', toggleTheme);
    }
    if (mobileThemeToggle) {
      mobileThemeToggle.addEventListener('click', toggleTheme);
    }

    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (!localStorage.getItem('trove_theme')) {
          applyTheme(e.matches ? 'dark' : 'light');
        }
      });
    }
  }

  function applyTheme(theme) {
    const isDark = theme === 'dark';
    if (isDark) {
      document.documentElement.classList.add('dark');
      if (document.body) document.body.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
      if (document.body) document.body.classList.remove('dark');
    }

    const themeToggleIcon = document.getElementById('theme-toggle-icon');
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    const mobileThemeIcon = document.getElementById('mobile-theme-icon');
    const mobileThemeLabel = document.getElementById('mobile-theme-label');
    const mobileThemeBadge = document.getElementById('mobile-theme-badge');

    if (themeToggleIcon) {
      themeToggleIcon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
    }
    if (mobileThemeIcon) {
      mobileThemeIcon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
    }
    if (mobileThemeLabel) {
      mobileThemeLabel.innerText = isDark ? 'Light Mode' : 'Dark Mode';
    }
    if (mobileThemeBadge) {
      mobileThemeBadge.innerText = isDark ? 'On' : 'Off';
    }

    if (window.lucide) {
      window.lucide.createIcons();
    }

    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', isDark ? '#0e1116' : '#22333b');
    }

    if (themeToggleBtn) {
      themeToggleBtn.title = isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
    }
  }

  function toggleTheme() {
    const isCurrentlyDark = document.documentElement.classList.contains('dark');
    const newTheme = isCurrentlyDark ? 'light' : 'dark';
    localStorage.setItem('trove_theme', newTheme);
    applyTheme(newTheme);

    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    if (window.Motion && Motion.animate && themeToggleBtn) {
      try {
        Motion.animate(themeToggleBtn, { rotate: [0, 180], scale: [0.88, 1] }, { duration: 0.3, easing: [0.22, 1, 0.36, 1] });
      } catch (_) {}
    }
  }

  // Mobile Navigation Dropdown
  function initMobileMenu() {
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const mobileNavMenu = document.getElementById('mobile-nav-menu');

    if (mobileMenuBtn && mobileNavMenu) {
      mobileMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = mobileNavMenu.classList.contains('hidden');
        mobileNavMenu.classList.toggle('hidden');
        if (willOpen && MotionAnim?.isAvailable()) {
          try {
            window.Motion.animate(
              mobileNavMenu,
              { opacity: [0, 1], transform: ['scale(0.96) translateY(-6px)', 'scale(1) translateY(0px)'] },
              { duration: 0.16, easing: 'ease-out' }
            );
          } catch (_) {}
        }
      });

      document.addEventListener('click', (e) => {
        if (!mobileNavMenu.classList.contains('hidden') && !mobileNavMenu.contains(e.target) && !mobileMenuBtn.contains(e.target)) {
          mobileNavMenu.classList.add('hidden');
        }
      });
    }
  }

  // Keyboard Shortcuts (Space, Arrows, Escape)
  function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const activeTagName = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      const isInput = activeTagName === 'input' || activeTagName === 'textarea' || document.activeElement.isContentEditable;

      if (isInput) {
        if (e.key === 'Escape') {
          document.activeElement.blur();
        }
        return;
      }

      const player = window.Trove.player;

      // Space: Toggle Play / Pause
      if (e.code === 'Space') {
        e.preventDefault();
        if (player) player.togglePlayPause();
      }

      // Left Arrow: Seek backward 5s
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (player) player.seekDelta(-5);
      }

      // Right Arrow: Seek forward 5s
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (player) player.seekDelta(5);
      }

      // Escape: Dismiss active panels in priority order
      if (e.key === 'Escape') {
        if (window.Trove.recommendations?.isOpen) {
          window.Trove.recommendations.close();
        } else if (window.Trove.equalizer?.isOpen) {
          window.Trove.equalizer.hide();
        } else if (window.Trove.settings?.isOpen) {
          window.Trove.settings.close();
        } else if (window.Trove.activity?.isOpen) {
          window.Trove.activity.close();
        } else if (window.Trove.importer?.isOpen) {
          window.Trove.importer.close();
        } else if (player?.isExpanded) {
          player.minimize();
        }
      }
    });
  }

  // PWA & Browser History / Back Gesture Trapping
  let lastBackPressTime = 0;
  let isExiting = false;

  function initHistoryNavigation() {
    if (!window.history || !window.history.pushState) return;

    window.history.replaceState({ trove: 'root' }, '');
    window.history.pushState({ trove: 'active' }, '');

    window.addEventListener('popstate', () => {
      if (isExiting) return;

      const player = window.Trove.player;
      const state = window.Trove.state || {};

      // 0. If EQ or Related bottom sheet is open, close it
      if (window.Trove.equalizer?.isOpen) {
        window.Trove.equalizer.hide();
        window.history.pushState({ trove: 'active' }, '');
        return;
      }
      if (window.Trove.recommendations?.isOpen) {
        window.Trove.recommendations.close();
        window.history.pushState({ trove: 'active' }, '');
        return;
      }

      // 1. If play bar expanded player is open, minimize it
      if (player?.isExpanded) {
        player.minimize();
        window.history.pushState({ trove: 'active' }, '');
        return;
      }

      // 2. If any modal or top drawer is open, close it
      if (window.Trove.settings?.isOpen) {
        window.Trove.settings.close();
        window.history.pushState({ trove: 'active' }, '');
        return;
      }
      if (window.Trove.importer?.isOpen) {
        window.Trove.importer.close();
        window.history.pushState({ trove: 'active' }, '');
        return;
      }
      if (window.Trove.activity?.isOpen) {
        window.Trove.activity.close();
        window.history.pushState({ trove: 'active' }, '');
        return;
      }

      // 3. If in subdirectory, navigate up to parent directory
      if (state.currentDirectory && state.currentDirectory !== '') {
        const parts = state.currentDirectory.split('/').filter(Boolean);
        parts.pop();
        state.currentDirectory = parts.join('/');
        if (window.Trove.store) window.Trove.store.saveViewSettings();
        if (window.Trove.explorer) window.Trove.explorer.render();
        window.history.pushState({ trove: 'active' }, '');
        return;
      }

      // 4. On Home/Root screen: Require double back action within 2 seconds to exit
      const now = Date.now();
      if (now - lastBackPressTime < 2000) {
        isExiting = true;
        try {
          window.close();
        } catch (_) {}
        window.history.back();
      } else {
        lastBackPressTime = now;
        if (showExitToast) showExitToast('Press back again to exit');
        window.history.pushState({ trove: 'active' }, '');
      }
    });
  }

  // App Initialization
  function init() {
    initTheme();
    initMobileMenu();
    initKeyboardShortcuts();
    initHistoryNavigation();

    const repoIdDisplay = document.getElementById('repo-id-display');
    const modalRepoId = document.getElementById('modal-repo-id');
    const authUsername = document.getElementById('auth-username');
    const repoBadge = document.getElementById('repo-badge');

    if (repoIdDisplay) repoIdDisplay.innerText = repo.id || '--';
    if (modalRepoId) modalRepoId.innerText = repo.id || '--';
    if (authUsername) authUsername.value = repo.owner || 'mnswa';
    if (repoBadge) repoBadge.innerText = repo.isPrivate ? 'Private Bucket' : 'Public Bucket';

    // Initialize all modules in sequence
    if (window.Trove.settings) window.Trove.settings.init();
    if (window.Trove.equalizer) window.Trove.equalizer.init();
    if (window.Trove.player) window.Trove.player.init();
    if (window.Trove.activity) window.Trove.activity.init();
    if (window.Trove.importer) window.Trove.importer.init();
    if (window.Trove.recommendations) window.Trove.recommendations.init();
    if (window.Trove.lyrics) window.Trove.lyrics.init();
    if (window.Trove.explorer) window.Trove.explorer.init();

    if (MotionAnim) MotionAnim.playAppIntro();

    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { scope: './' })
          .then((reg) => {
            console.log('Trove ServiceWorker active with scope:', reg.scope);
          })
          .catch((err) => {
            console.warn('Trove ServiceWorker registration note:', err);
          });
      });
    }

    if (window.lucide) {
      window.lucide.createIcons();
    }

    const state = window.Trove.state || {};
    if (state.token) {
      if (window.Trove.explorer) window.Trove.explorer.loadRepository(false);
    } else {
      if (window.Trove.settings) window.Trove.settings.open();
    }
  }

  // Start application once DOM is loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.Trove.app = { init, toggleTheme, applyTheme };
})();

