/* ============================================================
   Aegis 神盾 · Version SIX · 沉浸式演示（flow.js）
   —— Apple「Designing Fluid Interfaces」实践 ——
   1. 弹簧而非固定时长动画：阻尼比 ζ + 响应时间 t
   2. 可中断：手势拖拽从当前呈现值继续，不锁输入
   3. 速度交接：松手时把拖拽速度交给弹簧继续
   4. 动量投影：project(v) 投影到最近 snap 点
   5. 橡皮筋边界：越界回弹（constant 0.55）
   6. 半透明材料 + 减少动态降级
   ============================================================ */
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var el = function (id) { return document.getElementById(id); };
  var RAF = window.requestAnimationFrame || function (f) { return setTimeout(function () { f(Date.now()); }, 16); };

  var deck = el('deck'), panel = el('deckPanel'), scrim = el('deckScrim');
  var view = el('deckView'), track = el('deckTrack'), dotsBox = el('deckDots');
  var slides = Array.prototype.slice.call(document.querySelectorAll('#deck .slide'));
  var N = slides.length, MAX = N - 1;

  var D = { open: false, playing: false, cancelled: false, idx: 0 };

  /* ---------- 物理状态 ---------- */
  var pos = 0, vel = 0, target = 0, slideW = 0;
  var dragging = false, animating = false;
  var animDamp = 0.95, animResp = 0.5;
  var last = performance.now(), rafId = null, loopOn = false;

  function measure() { slideW = view.clientWidth || 1; }

  /* ---------- 苹果官方公式 ---------- */
  function rubber(d) { var dim = Math.max(slideW, 1), c = 0.55; return d * dim * c / (dim + c * Math.abs(d)); }
  function clampPos(raw) {
    if (raw < 0) return rubber(raw);
    if (raw > MAX) return MAX + rubber(raw - MAX);
    return raw;
  }
  function clampIdx(i) { return Math.max(0, Math.min(MAX, i)); }

  /* ---------- 渲染 ---------- */
  function render() {
    track.style.transform = 'translate3d(' + (-pos * slideW) + 'px,0,0)';
    updateDots(Math.round(pos));
  }
  function buildDots() {
    dotsBox.innerHTML = '';
    for (var i = 0; i < N; i++) {
      var b = document.createElement('button');
      b.className = 'dot';
      b.setAttribute('aria-label', '第 ' + (i + 1) + ' 步');
      (function (k) { b.addEventListener('click', function () { goTo(k, true); }); })(i);
      dotsBox.appendChild(b);
    }
    updateDots(0);
  }
  function updateDots(r) {
    var ds = dotsBox.children;
    for (var i = 0; i < ds.length; i++) ds[i].classList.toggle('on', i === r);
  }

  function setAnim(damp, resp) { animDamp = damp; animResp = resp; }

  function startLoop() {
    if (loopOn) return;
    loopOn = true; last = performance.now();
    rafId = RAF(loop);
  }
  function loop(t) {
    var dt = Math.min((t - last) / 1000, 1 / 30);
    last = t;
    if (!dragging) {
      var w0 = 2 * Math.PI / animResp, k = w0 * w0, c = 2 * animDamp * w0;
      var a = -k * (pos - target) - c * vel;
      vel += a * dt;
      pos += vel * dt;
      if (Math.abs(pos - target) < 0.0006 && Math.abs(vel) < 0.0006) {
        pos = target; vel = 0; animating = false;
      }
    }
    render();
    if (dragging || animating || D.open) rafId = RAF(loop);
    else { loopOn = false; rafId = null; }
  }

  /* ---------- 手势（拖拽 + 惯性） ---------- */
  var sx = 0, sy = 0, startPos = 0, tracking = false, moved = false, hist = [];
  function pdown(e) {
    if (e.button && e.button !== 0) return;
    tracking = true; moved = false; dragging = true; animating = false;
    sx = e.clientX; sy = e.clientY; startPos = pos;
    target = pos; vel = 0;
    hist = [{ t: performance.now(), x: e.clientX }];
    startLoop();
  }
  function pmove(e) {
    if (!tracking) return;
    var dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved) {
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      moved = true;
    }
    pos = clampPos(startPos - dx / slideW);
    hist.push({ t: performance.now(), x: e.clientX });
    if (hist.length > 10) hist.shift();
    render();
  }
  function pup(e) {
    if (!tracking) return;
    tracking = false;
    hist.push({ t: performance.now(), x: e.clientX });
    var v = 0;
    if (hist.length >= 2) {
      var a0 = hist[0], a1 = hist[hist.length - 1];
      var dtt = (a1.t - a0.t) / 1000;
      if (dtt > 0.004) v = (a1.x - a0.x) / dtt;
    }
    vel = -v / slideW;               // 拖拽速度交给弹簧（速度交接）
    dragging = false;
    var proj = vel * 0.24;           // 动量投影
    target = clampIdx(Math.round(pos + proj));
    D.idx = target;
    if (Math.abs(vel) > 0.12) setAnim(0.85, 0.42); else setAnim(0.9, 0.5);
    animating = true;
    startLoop();
  }

  view.addEventListener('mousedown', pdown);
  window.addEventListener('mousemove', pmove);
  window.addEventListener('mouseup', pup);
  view.addEventListener('touchstart', function (e) {
    var t = e.touches && e.touches[0]; if (!t) return;
    pdown({ clientX: t.clientX, clientY: t.clientY, button: 0 });
  }, { passive: true });
  view.addEventListener('touchmove', function (e) {
    if (!tracking) return;
    var t = e.touches && e.touches[0]; if (!t) return;
    pmove({ clientX: t.clientX, clientY: t.clientY });
  }, { passive: true });
  view.addEventListener('touchend', function (e) {
    var t = e.changedTouches && e.changedTouches[0];
    if (t) pup({ clientX: t.clientX });
  }, { passive: true });

  /* ---------- 面板弹簧呈现 ---------- */
  var panelAnim = null;
  function applyPanel(p) {
    var scale = 0.92 + 0.08 * p;
    var ty = 24 * (1 - p);
    panel.style.transform = 'translate(-50%,-50%) translateY(' + ty + 'px) scale(' + scale + ')';
    panel.style.opacity = String(Math.min(1, Math.max(0, p)));
  }
  function openDeck() {
    if (D.open) return;
    D.open = true;
    measure();
    deck.classList.add('open');
    deck.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    pos = D.idx; target = pos; vel = 0; animating = false;
    render();
    if (reduce) { panel.style.transform = 'translate(-50%,-50%)'; panel.style.opacity = '1'; }
    else {
      if (panelAnim) panelAnim.cancel();
      panelAnim = FX.springTo(panel, 'pv', 1, {
      from: 0, damping: 0.8, response: 0.3,
      onUpdate: applyPanel
    });
    }
    startLoop();
  }
  function closeDeck() {
    if (!D.open) return;
    D.open = false; D.cancelled = true; D.playing = false;
    document.body.style.overflow = '';
    deck.setAttribute('aria-hidden', 'true');
    if (reduce) { deck.classList.remove('open'); return; }
    if (panelAnim) panelAnim.cancel();
    panelAnim = FX.springTo(panel, 'pv', 0, {
      from: panel.pv != null ? panel.pv : 1, damping: 0.9, response: 0.28,
      onUpdate: applyPanel,
      onDone: function () {
        deck.classList.remove('open');
        panel.style.transform = ''; panel.style.opacity = '';
        panel.pv = 0;
      }
    });
  }
  function goTo(i, manual) {
    i = clampIdx(i);
    if (manual) { D.cancelled = true; D.playing = false; }
    D.idx = i; target = i;
    setAnim(0.95, 0.5);
    animating = true;
    startLoop();
  }

  scrim.addEventListener('click', closeDeck);
  el('deckClose').addEventListener('click', closeDeck);
  el('deckPrev').addEventListener('click', function () { goTo(D.idx - 1, true); });
  el('deckNext').addEventListener('click', function () { goTo(D.idx + 1, true); });
  el('deckReplay').addEventListener('click', function () {
    closeDeck();
    setTimeout(function () { guidedDemo(); }, 320);
  });
  document.addEventListener('keydown', function (e) {
    if (!D.open) return;
    if (e.key === 'Escape') closeDeck();
    else if (e.key === 'ArrowRight') goTo(D.idx + 1, true);
    else if (e.key === 'ArrowLeft') goTo(D.idx - 1, true);
  });

  window.addEventListener('resize', function () { if (D.open) { measure(); render(); } });

  /* ---------- 工具 ---------- */
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function waitForResolve(timeout) {
    return new Promise(function (res) {
      var t0 = Date.now();
      var iv = setInterval(function () {
        var pipe = el('pipe'), lit = pipe && pipe.querySelector('.ps.lit');
        var cur = lit ? +lit.dataset.s : -1;
        if (cur >= 5 || D.cancelled || Date.now() - t0 > timeout) { clearInterval(iv); res(); }
      }, 200);
    });
  }

  /* ---------- 实时数据同步到幻灯片 ---------- */
  function numOf(txt) { var m = /([0-9][0-9,]*)/.exec(txt || ''); return m ? m[1] : '0'; }
  function sync() {
    var r = Math.round(pos);
    if (r === 1) {
      var nd = document.querySelector('#nodeList .node');
      if (nd) {
        var spans = nd.querySelectorAll('.node-meta span');
        for (var k = 0; k < spans.length; k++) {
          if (spans[k].textContent.indexOf('风险分') >= 0) {
            var bb = spans[k].querySelector('b'), g = el('vRisk');
            if (bb && g) g.textContent = bb.textContent;
          }
        }
      }
    }
    if (r === 2) { var p = el('qPremium'), w = el('vPrem'); if (p && w) w.textContent = p.textContent; }
    if (r === 4) {
      var cd = document.querySelector('[id^="cd"]'), n = el('vCdNum'), ring = el('vCdRing');
      if (cd && n) {
        var s = parseInt(cd.textContent) || 0;
        n.textContent = s;
        if (ring) ring.style.background = 'conic-gradient(var(--blue) ' + (Math.max(0, s) / 24 * 100) + '%, #e8e8ed 0)';
      }
    }
    if (r === 5) { var a = el('flAmt'), w = el('vPay'); if (a && w) w.textContent = a.textContent; }
  }
  setInterval(sync, 220);

  /* ---------- 一键演示（沉浸式自动播放） ---------- */
  window.guidedDemo = async function () {
    if (D.playing) return;
    D.playing = true; D.cancelled = false;
    buildDots();
    D.idx = 0; pos = 0; target = 0; vel = 0;
    openDeck();
    goTo(0);
    await wait(2600); if (D.cancelled) return endRun();
    goTo(1); registerNode(2000); await wait(3000); if (D.cancelled) return endRun();
    goTo(2); lpDeposit(50000); await wait(700); buyPolicy(); await wait(3200); if (D.cancelled) return endRun();
    goTo(3); var idx = Math.max(0, document.querySelectorAll('#nodeList .node').length - 1); simulateDown(idx); await wait(3400); if (D.cancelled) return endRun();
    goTo(4); await waitForResolve(38000); if (D.cancelled) return endRun();
    goTo(5); await wait(3600); if (D.cancelled) return endRun();
    goTo(6); endRun();
  };
  window.closeDeck = closeDeck;

  function endRun() { D.playing = false; }

  /* 初始测量 */
  measure();
})();