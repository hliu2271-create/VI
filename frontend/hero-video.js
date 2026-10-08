/* One video keeps its playback state in both the hero and floating layouts. */
(function () {
  const video = document.getElementById('heroDemoVideo');
  const slot = document.getElementById('heroFilmSlot');
  if (!video || !slot) return;
  const film = slot.querySelector('.hero-film');
  const topbar = document.getElementById('topbar');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const blockers = new Set();
  let wantsPlay = !reduce.matches;
  let dismissed = false;
  let floating = false;
  let scheduled = false;
  const compact = matchMedia('(max-width: 650px)');
  let minimized = compact.matches;
  const minimizeButton = film.querySelector('[data-film-toggle]');
  if (minimizeButton) minimizeButton.addEventListener('click', function () { minimized = !minimized; updateLayout(); });
  compact.addEventListener('change', function () { minimized = compact.matches; updateLayout(); });

  function syncPlayback() {
    if (blockers.size || !wantsPlay) { video.pause(); return; }
    if (!video.paused) return;
    video.play().catch(function (error) {
      if (error.name !== 'AbortError') wantsPlay = false;
    });
  }

  function setFloating(next) {
    floating = next;
    film.classList.toggle('is-floating', next);
    film.classList.toggle('is-minimized', next && minimized);
    if (next && minimized) blockers.add('minimized'); else blockers.delete('minimized');
    if (minimizeButton) {
      minimizeButton.textContent = minimized ? '+' : '−';
      minimizeButton.setAttribute('aria-expanded', String(!minimized));
      minimizeButton.setAttribute('aria-label', minimized ? '展开视频小窗' : '收起视频小窗');
    }
    document.body.classList.toggle('video-floating', next);
    film.setAttribute('aria-label', next ? '算力保险协议演示视频悬浮小窗' : '算力保险协议流程演示视频');
    if (next) document.body.style.setProperty('--mini-film-height', film.getBoundingClientRect().height + 'px');
  }

  function updateLayout() {
    scheduled = false;
    const rect = slot.getBoundingClientRect();
    const headerBottom = topbar ? Math.max(0, topbar.getBoundingClientRect().bottom) : 0;
    const passed = rect.bottom <= headerBottom + 12;
    setFloating(passed && !dismissed);
    const homeVisible = rect.bottom > headerBottom && rect.top < window.innerHeight;
    if (floating || homeVisible) blockers.delete('offscreen'); else blockers.add('offscreen');
    if (document.hidden) blockers.add('hidden'); else blockers.delete('hidden');
    syncPlayback();
  }

  function scheduleLayout() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(updateLayout);
  }

  function measureHome() {
    // Measure inline dimensions in one frame. The media node stays in place.
    const wasFloating = floating;
    film.classList.remove('is-floating');
    slot.style.height = film.getBoundingClientRect().height + 'px';
    film.classList.toggle('is-floating', wasFloating);
    updateLayout();
  }

  window.playDemoVideo = function () {
    dismissed = false;
    minimized = false;
    wantsPlay = true;
    video.currentTime = 0;
    const rect = slot.getBoundingClientRect();
    const headerBottom = topbar ? Math.max(0, topbar.getBoundingClientRect().bottom) : 0;
    if (rect.bottom > headerBottom + 12 && (rect.top < headerBottom + 12 || rect.bottom > window.innerHeight - 12)) {
      slot.scrollIntoView({ behavior: reduce.matches ? 'instant' : 'smooth', block: 'center' });
    }
    updateLayout();
  };

  film.querySelector('[data-film-return]').addEventListener('click', function () {
    slot.scrollIntoView({ behavior: reduce.matches ? 'instant' : 'smooth', block: 'center' });
    scheduleLayout();
    video.focus({ preventScroll: true });
  });

  film.querySelector('[data-film-close]').addEventListener('click', function () {
    dismissed = true;
    wantsPlay = false;
    updateLayout();
    const entry = document.querySelector('.top-right .btn.primary');
    if (entry) entry.focus({ preventScroll: true });
  });

  video.addEventListener('pause', function () {
    if (!blockers.size) wantsPlay = false;
  });
  video.addEventListener('play', function () {
    wantsPlay = true;
    dismissed = false;
    if (blockers.size) video.pause();
  });
  window.addEventListener('scroll', scheduleLayout, { passive: true });
  window.addEventListener('resize', measureHome, { passive: true });
  document.addEventListener('visibilitychange', updateLayout);
  reduce.addEventListener('change', function () { wantsPlay = !reduce.matches; updateLayout(); });
  if (document.fonts) document.fonts.ready.then(measureHome);
  measureHome();
})();
