/* ============================================================
   Aegis 神盾 · Version SIX · 动效层（fx.js）
   手写 rAF 弹簧引擎（阻尼比 ζ + 响应时间 t，Apple 官方参数）
   提供 window.FX.springTo；并处理标题入场 / 滚动揭示 / 视差
   ============================================================ */
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var RAF = window.requestAnimationFrame || function (f) { return setTimeout(function () { f(Date.now()); }, 16); };
  var CAF = window.cancelAnimationFrame || clearTimeout;

  /* ---------- 弹簧引擎 ----------
     damping: 阻尼比（1.0 无回弹 · 0.8 轻微回弹）
     response: 响应时间（秒）
     内部用半隐式欧拉积分，只动 transform/opacity，丝般顺滑 */
  function springTo(obj, key, to, opts) {
    opts = opts || {};
    var damp = opts.damping != null ? opts.damping : 1;
    var resp = opts.response != null ? opts.response : 0.4;
    var mass = opts.mass || 1;
    var from = opts.from != null ? opts.from : (obj[key] != null ? obj[key] : to);
    obj[key] = from;
    var w0 = 2 * Math.PI / resp;
    var k = w0 * w0 * mass;
    var c = 2 * damp * w0 * mass;
    var v = opts.velocity || 0;
    var last = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var raf;
    function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
    function step(t) {
      var dt = Math.min((t - last) / 1000, 1 / 24); last = t;
      var F = -k * (obj[key] - to) - c * v;
      v += (F / mass) * dt;
      obj[key] += v * dt;
      if (opts.onUpdate) opts.onUpdate(obj[key], v);
      var settled = Math.abs(obj[key] - to) < 0.0004 && Math.abs(v) < 0.0004;
      if (settled) {
        obj[key] = to;
        if (opts.onUpdate) opts.onUpdate(to, 0);
        if (opts.onDone) opts.onDone();
        return;
      }
      raf = RAF(step);
    }
    raf = RAF(step);
    return { cancel: function () { CAF(raf); } };
  }

  /* ---------- 标题逐字弹簧入场 ---------- */
  function splitTitle() {
    var el = document.querySelector('[data-split]');
    if (!el) return;
    var text = el.textContent.trim();
    el.textContent = '';
    el.setAttribute('aria-label', text);
    var chars = Array.from(text);
    var frag = document.createDocumentFragment();
    chars.forEach(function (ch) {
      var s = document.createElement('span');
      s.className = 'w';
      s.textContent = ch === ' ' ? '\u00A0' : ch;
      if (reduce) { s.style.opacity = '1'; s.style.transform = 'none'; }
      else { s.style.opacity = '0'; s.style.transform = 'translateY(38px)'; }
      frag.appendChild(s);
    });
    el.appendChild(frag);
    if (reduce) return;
    var spans = el.querySelectorAll('.w');
    var delay = 120;
    Array.prototype.forEach.call(spans, function (s, i) {
      setTimeout(function () {
        springTo(s, 'oy', 0, {
          from: 38, damping: 0.82, response: 0.55,
          onUpdate: function (v) { s.style.transform = 'translateY(' + v + 'px)'; s.style.opacity = 1; }
        });
      }, delay + i * 42);
    });
  }

  /* ---------- 滚动揭示 ---------- */
  function scrollReveal() {
    var els = document.querySelectorAll('[data-reveal]');
    if (!('IntersectionObserver' in window) || reduce) {
      els.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });
    els.forEach(function (el) { io.observe(el); });
    // 立即显示首屏内已经可见的元素，避免依赖观察器时序
    els.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight - 40 && r.bottom > 0) { el.classList.add('in'); io.unobserve(el); }
    });
  }

  /* ---------- 主视觉视差 ---------- */
  function parallax() {
    if (reduce) return;
    var imgs = document.querySelectorAll('[data-parallax]');
    if (!imgs.length) return;
    var ticking = false;
    function update() {
      var y = window.scrollY || window.pageYOffset || 0;
      imgs.forEach(function (img) { img.style.transform = 'translateY(' + (y * 0.18) + 'px) scale(1.04)'; });
      ticking = false;
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { RAF(update); ticking = true; }
    }, { passive: true });
    update();
  }

  /* ---------- 顶栏滚动态 ---------- */
  function headerScroll() {
    var bar = document.getElementById('topbar');
    if (!bar) return;
    function update() {
      var y = window.scrollY || window.pageYOffset || 0;
      bar.classList.toggle('scrolled', y > 8);
    }
    window.addEventListener('scroll', function () { RAF(update); }, { passive: true });
    update();
  }

  /* ---------- Hero 统计同步 ---------- */
  function syncHeroStats() {
    var map = { hPool: 'kPool', hPolicies: 'kPolicies', hPaid: 'kPaid' };
    Object.keys(map).forEach(function (heroId) {
      var src = document.getElementById(map[heroId]);
      var dst = document.getElementById(heroId);
      if (src && dst) dst.textContent = src.textContent;
    });
  }

  function terminalTabs() {
    var items = document.querySelectorAll('.side-item');
    var views = document.querySelectorAll('.view');
    var title = document.getElementById('twTitle');
    if (!items.length) return;
    items.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var t = btn.dataset.tab;
        items.forEach(function (b) { b.classList.toggle('active', b === btn); });
        views.forEach(function (v) { v.classList.toggle('active', v.dataset.view === t); });
        if (title) {
          var lbl = btn.querySelector('span:not(.side-ic)');
          if (lbl) title.textContent = 'ComputeShield — ' + lbl.textContent.trim();
        }
        RAF(function () { window.dispatchEvent(new Event('resize')); });
      });
    });
  }

  function syncChainSt() {
    var m = document.getElementById('modePill');
    var s = document.getElementById('chainSt');
    if (!m || !s) return;
    s.textContent = m.textContent;
    s.classList.toggle('off', m.textContent.indexOf('演示') >= 0);
    var terminalMode = document.getElementById('terminalMode');
    if (terminalMode) terminalMode.textContent = m.textContent.indexOf('演示') >= 0 ? '本地演示' : '链上接入';
  }

  /* ---------- 滚动进度条 ---------- */
  function progressBar() {
    var bar = document.getElementById('progressBar');
    if (!bar) return;
    var inner = bar.querySelector('i') || bar;
    function update() {
      var doc = document.documentElement;
      var max = doc.scrollHeight - window.innerHeight;
      var k = max > 0 ? (window.scrollY || window.pageYOffset || 0) / max : 0;
      inner.style.transform = 'scaleX(' + Math.min(1, Math.max(0, k)) + ')';
    }
    window.addEventListener('scroll', function () { RAF(update); }, { passive: true });
    update();
  }

  /* ---------- 卡片聚光（鼠标跟随） ---------- */
  function spotlight() {
    if (reduce || !('CSS' in window)) return;
    var cards = document.querySelectorAll('.biz-card, .principle');
    cards.forEach(function (el) {
      el.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect();
        el.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
        el.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
      });
    });
  }

  /* ---------- 磁吸按钮（桌面端，独立 translate 属性，不干扰按压缩放） ---------- */
  function magnetic() {
    if (reduce) return;
    if (window.matchMedia && !window.matchMedia('(hover:hover)').matches) return;
    var btns = document.querySelectorAll('.btn.primary, .cta-btn');
    btns.forEach(function (b) {
      b.style.transition = 'background .18s, color .18s, transform .1s, opacity .18s, box-shadow .18s, translate .22s cubic-bezier(.2,.8,.2,1)';
      b.addEventListener('mousemove', function (e) {
        var r = b.getBoundingClientRect();
        var dx = e.clientX - (r.left + r.width / 2);
        var dy = e.clientY - (r.top + r.height / 2);
        b.style.translate = (dx * 0.14).toFixed(1) + 'px ' + (dy * 0.22).toFixed(1) + 'px';
      });
      b.addEventListener('mouseleave', function () { b.style.translate = '0px 0px'; });
    });
  }

  /* ---------- 鼠标驱动的卡片透视；移动端及减少动态效果时停用 ---------- */
  function tilt() {
    var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    var pointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    var cards = document.querySelectorAll('.biz-card, .principle, .stat-card');
    cards.forEach(function (el) {
      var frame = 0, rect = null, active = false;
      var x = 0, y = 0, targetX = 0, targetY = 0, last = 0;
      var limit = el.classList.contains('stat-card') ? 4 : 6;
      function enabled() { return pointer.matches && !motion.matches && !document.hidden; }
      function reset() {
        active = false; rect = null;
        CAF(frame); frame = 0; last = 0;
        x = y = targetX = targetY = 0;
        el.classList.remove('is-tilting');
        el.style.removeProperty('transform');
        el.style.removeProperty('--mx'); el.style.removeProperty('--my');
      }
      function draw(time) {
        frame = 0;
        if (!active || !enabled()) { reset(); return; }
        var dt = last ? Math.min(50, time - last) : 16;
        last = time;
        var ease = 1 - Math.exp(-dt / 65);
        x += (targetX - x) * ease; y += (targetY - y) * ease;
        el.style.transform = 'perspective(1000px) translateY(-5px) rotateX(' + x.toFixed(2) + 'deg) rotateY(' + y.toFixed(2) + 'deg)';
        if (Math.abs(targetX - x) + Math.abs(targetY - y) > 0.02) frame = RAF(draw);
        else last = 0;
      }
      el.addEventListener('pointerenter', function (e) {
        if (e.pointerType !== 'mouse' || !enabled()) return;
        rect = el.getBoundingClientRect(); active = true;
        el.classList.add('is-tilting');
      });
      el.addEventListener('pointermove', function (e) {
        if (!active || !rect || !enabled()) return;
        var px = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        var py = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        targetX = (0.5 - py) * limit * 2;
        targetY = (px - 0.5) * limit * 2;
        el.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
        el.style.setProperty('--my', (py * 100).toFixed(1) + '%');
        if (!frame) frame = RAF(draw);
      });
      el.addEventListener('pointerleave', reset);
      el.addEventListener('pointercancel', reset);
      window.addEventListener('blur', reset);
      window.addEventListener('resize', reset, { passive: true });
      window.addEventListener('scroll', reset, { passive: true });
      document.addEventListener('visibilitychange', reset);
      motion.addEventListener('change', reset);
      pointer.addEventListener('change', reset);
    });
  }

  /* ---------- 彩蛋：连续点 Logo 5 次激活神盾 ---------- */
  function easterEgg() {
    var mk = document.querySelector('.brand .mk');
    if (!mk) return;
    var n = 0, timer;
    mk.addEventListener('click', function () {
      n++;
      clearTimeout(timer);
      if (n >= 5) {
        n = 0;
        mk.classList.remove('pulse');
        void mk.offsetWidth;
        mk.classList.add('pulse');
        if (typeof toast === 'function') toast('🛡️ 神盾已激活 · 演示模式', 'ok');
      } else {
        timer = setTimeout(function () { n = 0; }, 1200);
      }
    });
  }

  window.FX = { springTo: springTo };

  function init() {
    splitTitle(); scrollReveal(); parallax(); headerScroll(); terminalTabs(); progressBar(); easterEgg(); syncHeroStats(); syncChainSt();
    setInterval(function () { syncHeroStats(); syncChainSt(); }, 700);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
