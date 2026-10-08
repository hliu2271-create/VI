/* ============================================================
   Aegis 神盾 · Version NINE · 组件层（components.js）
   —— 灵感：ShaderGradient（动态网格渐变背景）+ FigComponents（数据可视化组件）
   1) 全屏/主视觉 WebGL 风格的动态网格渐变（Canvas2D 实现，颜色沿用品牌色）
   2) 实时心跳监测 ECG 波形（算力节点健康可视化）
   3) 实时区块高度 Sparkline（链上活跃度可视化）
   ============================================================ */
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var RAF = window.requestAnimationFrame || function (f) { return setTimeout(function () { f(Date.now()); }, 16); };
  var P = typeof performance !== 'undefined' ? performance : { now: function () { return Date.now(); } };

  function setup(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) { return false; }
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  /* ---------- 1) ShaderGradient 风格动态网格渐变 ---------- */
  function meshGradient() {
    var canvas = document.getElementById('mesh');
    if (!canvas) return;
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    var W = 0, H = 0, dpr = 1;
    function resize() {
      dpr = window.devicePixelRatio || 1;
      W = canvas.clientWidth || 0; H = canvas.clientHeight || 0;
      if (W && H) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
    resize();
    window.addEventListener('resize', resize);

    var blobs = [
      { c: [10, 132, 255], r: 0.60, x: 0.20, y: 0.24, sx: 0.12, sy: 0.09, ph: 0.0, a: 0.50 },
      { c: [88, 86, 214],  r: 0.58, x: 0.80, y: 0.20, sx: 0.10, sy: 0.08, ph: 2.1, a: 0.46 },
      { c: [48, 176, 199], r: 0.54, x: 0.56, y: 0.82, sx: 0.09, sy: 0.07, ph: 4.2, a: 0.40 },
      { c: [191, 90, 242], r: 0.48, x: 0.14, y: 0.88, sx: 0.08, sy: 0.06, ph: 1.2, a: 0.34 },
      { c: [0, 122, 255],  r: 0.44, x: 0.46, y: 0.44, sx: 0.07, sy: 0.06, ph: 3.4, a: 0.30 }
    ];

    function draw(t) {
      if (!W || !H) return;
      ctx.clearRect(0, 0, W, H);
      var m = Math.max(W, H);
      for (var i = 0; i < blobs.length; i++) {
        var b = blobs[i];
        var bx = (b.x + Math.sin(t * b.sx + b.ph) * 0.16) * W;
        var by = (b.y + Math.cos(t * b.sy + b.ph) * 0.16) * H;
        var rad = b.r * m;
        var g = ctx.createRadialGradient(bx, by, 0, bx, by, rad);
        g.addColorStop(0, 'rgba(' + b.c[0] + ',' + b.c[1] + ',' + b.c[2] + ',' + b.a + ')');
        g.addColorStop(1, 'rgba(' + b.c[0] + ',' + b.c[1] + ',' + b.c[2] + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(bx, by, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (reduce) { draw(0); return; }
    var t0 = P.now();
    (function loop(t) { draw((t - t0) / 1000); RAF(loop); })(t0);
  }

  /* ---------- 2) 实时心跳 ECG ---------- */
  function ecg() {
    var canvas = document.getElementById('ecg');
    if (!canvas) return;
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    var W = 0, H = 0, dpr = 1;
    function resize() {
      dpr = window.devicePixelRatio || 1;
      W = canvas.clientWidth || 0; H = canvas.clientHeight || 0;
      if (W && H) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
    resize();
    window.addEventListener('resize', resize);
    var stateEl = document.getElementById('ecgState');

    function healthy() {
      var srv = document.getElementById('srvPill');
      if (srv && srv.classList.contains('on')) return true;
      return !!document.querySelector('#nodeList .node:not(.off)');
    }
    function wave(x) {
      return 0.18 * Math.exp(-Math.pow((x - 0.12) / 0.030, 2))
           - 0.14 * Math.exp(-Math.pow((x - 0.27) / 0.018, 2))
           + 1.15 * Math.exp(-Math.pow((x - 0.32) / 0.040, 2))
           - 0.20 * Math.exp(-Math.pow((x - 0.37) / 0.018, 2))
           + 0.28 * Math.exp(-Math.pow((x - 0.58) / 0.050, 2));
    }

    var t0 = P.now(), off = 0;
    (function loop(t) {
      var dt = (t - t0) / 1000; t0 = t;
      if (W > 4 && H > 4) {
        var ok = healthy();
        if (stateEl) { stateEl.textContent = ok ? '在线' : '宕机'; stateEl.classList.toggle('bad', !ok); }
        ctx.clearRect(0, 0, W, H);
        ctx.strokeStyle = 'rgba(0,0,0,0.045)';
        ctx.lineWidth = 1;
        var gy = Math.max(14, H / 4);
        for (var y = 0; y <= H; y += gy) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
        for (var x = 0; x <= W; x += gy) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }

        off += dt * 130;
        var mid = H / 2, amp = H * 0.36, period = Math.max(1, W * 0.5);
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = ok ? 'rgba(52,199,89,0.95)' : 'rgba(255,59,48,0.95)';
        ctx.shadowColor = ok ? 'rgba(52,199,89,0.55)' : 'rgba(255,59,48,0.55)';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        for (var px = 0; px <= W; px += 2) {
          var ph = ((px + off) / period) % 1;
          var v = ok ? wave(ph) : Math.sin(px * 0.02 + t * 3) * 0.04;
          var yy = mid - v * amp;
          if (px === 0) ctx.moveTo(px, yy); else ctx.lineTo(px, yy);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      RAF(loop);
    })(P.now());
  }

  /* ---------- 3) 实时区块高度 Sparkline ---------- */
  function sparkline() {
    var canvas = document.getElementById('spark');
    if (!canvas) return;
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    var W = 0, H = 0, dpr = 1;
    function resize() {
      dpr = window.devicePixelRatio || 1;
      W = canvas.clientWidth || 0; H = canvas.clientHeight || 0;
      if (W && H) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
    resize();
    window.addEventListener('resize', resize);

    var hist = [], maxLen = 90, valEl = document.getElementById('sparkVal');
    function sample() {
      var el = document.getElementById('block');
      var n = el ? parseInt(String(el.textContent).replace(/,/g, ''), 10) || 0 : 0;
      if (!n) return;
      if (!hist.length || n !== hist[hist.length - 1]) hist.push(n);
      if (hist.length > maxLen) hist.shift();
      if (valEl) valEl.textContent = n.toLocaleString('en-US');
    }
    sample();
    setInterval(sample, 800);

    function draw() {
      if (W < 4 || H < 4 || hist.length < 2) { RAF(draw); return; }
      ctx.clearRect(0, 0, W, H);
      var min = Math.min.apply(null, hist), max = Math.max.apply(null, hist);
      var range = (max - min) || 1;
      var step = W / (maxLen - 1);
      function xy(i, v) {
        var x = W - (hist.length - 1 - i) * step;
        var y = H - ((v - min) / range) * (H - 8) - 4;
        return [x, y];
      }
      ctx.beginPath();
      ctx.moveTo(W - (hist.length - 1) * step, H);
      for (var i = 0; i < hist.length; i++) { var p = xy(i, hist[i]); ctx.lineTo(p[0], p[1]); }
      ctx.lineTo(W, H);
      ctx.closePath();
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(10,132,255,0.22)');
      g.addColorStop(1, 'rgba(10,132,255,0)');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.beginPath();
      for (var j = 0; j < hist.length; j++) { var q = xy(j, hist[j]); if (j === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]); }
      ctx.strokeStyle = 'rgba(10,132,255,0.9)';
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      RAF(draw);
    }
    draw();
  }

  /* ---------- 启动 ---------- */
  function init() {
    meshGradient();
    ecg();
    // IV: no synthetic block-height activity.
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();