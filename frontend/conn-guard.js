/* ═══════════════════════════════════════════════════════════
   conn-guard —— 连接守卫（全站通用）
   解决两类「界面空白、演示失败」的真实场景：
   ① 用户以 file:// 双击打开页面 → 所有接口不可用
   ② 本地/线上服务未启动或中途掉线 → 数据全部加载失败
   行为：hook fetch 统计连续失败 → 显眼横幅给出解决指引；
        显示期间每 2s 自动探测，恢复即自动收起。
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var FILE_MODE = location.protocol === 'file:';
  var PROBE_URL = '/api/state';
  var fails = 0, shown = false, probeTimer = null, tipTimer = null;

  /* ── 样式（一次注入） ── */
  var css = document.createElement('style');
  css.textContent =
    '#connGuard{background:#e0393e;color:#fff;font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:10px 16px;display:none}' +
    '#connGuard .cg-in{max-width:1180px;margin:0 auto;display:flex;align-items:center;gap:12px;flex-wrap:wrap}' +
    '#connGuard .cg-dot{width:8px;height:8px;background:#fff;border-radius:50%;flex:none;animation:cgPulse 1.2s infinite}' +
    '@keyframes cgPulse{0%,100%{opacity:1}50%{opacity:.15}}' +
    '#connGuard .cg-msg{min-width:0}' +
    '#connGuard .cg-msg b{font-weight:700}' +
    '#connGuard code{background:rgba(0,0,0,.22);padding:1px 6px;font:12px ui-monospace,Consolas,monospace}' +
    '#connGuard .cg-sp{flex:1 1 24px}' +
    '#connGuard .cg-btn{background:#fff;color:#1a1a1a;border:0;padding:5px 14px;font-size:12px;font-weight:700;cursor:pointer;flex:none;font-family:inherit}' +
    '#connGuard .cg-btn:hover{background:#ffe3e3}' +
    '#connGuard .cg-sub{display:block;font-size:12px;opacity:.92;margin-top:2px}';
  document.head.appendChild(css);

  /* ── 横幅 DOM（插在 body 最前，正常文档流，不遮挡任何内容） ── */
  var bar = document.createElement('div');
  bar.id = 'connGuard';
  bar.innerHTML =
    '<div class="cg-in">' +
    '<span class="cg-dot"></span>' +
    '<span class="cg-msg"><b id="cgTitle">…</b><span class="cg-sub" id="cgSub"></span></span>' +
    '<span class="cg-sp"></span>' +
    '<button class="cg-btn" id="cgRetry" type="button">立即重试</button>' +
    '<button class="cg-btn" id="cgCopy" type="button" style="display:none">复制启动命令</button>' +
    '<button class="cg-btn" id="cgReload" type="button">刷新页面</button>' +
    '</div>';

  function ensureDom() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () { document.body.prepend(bar); if (shown) render(); });
    } else if (!bar.parentNode) {
      document.body.prepend(bar);
    }
  }

  function render() {
    ensureDom();
    var title = document.getElementById('cgTitle');
    var sub = document.getElementById('cgSub');
    var copy = document.getElementById('cgCopy');
    if (!title) return;
    if (FILE_MODE) {
      title.textContent = '当前为离线预览，业务数据需要本地服务';
      sub.innerHTML = '解决：双击项目目录下的 <code>start-server.bat</code> 启动本地服务，然后在浏览器访问 <code>http://127.0.0.1:8788/</code>';
      copy.style.display = '';
      bar.style.display = 'block';
    } else {
      title.textContent = '本地服务暂未连接（连续失败 ' + fails + ' 次）—— 数据无法加载，正在自动重连';
      sub.innerHTML = '若是本地演示：双击项目目录下的 <code>start-server.bat</code>（或在 ComputeShield 目录执行 <code>node server/start.js</code>）；若通过线上链接访问，请检查部署服务是否正常运行';
      copy.style.display = 'none';
      bar.style.display = 'block';
    }
  }

  function hide() {
    shown = false;
    bar.style.display = 'none';
    if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
    if (tipTimer) { clearInterval(tipTimer); tipTimer = null; }
  }

  function show() {
    if (shown) { render(); return; }
    shown = true;
    render();
    probeTimer = setInterval(probe, 2000);
  }

  function ok() {
    fails = 0;
    if (shown && !FILE_MODE) hide();
  }

  function fail() {
    fails++;
    if (fails >= 2) show();
  }

  function probe() {
    if (FILE_MODE) return;
    fetch(PROBE_URL, { cache: 'no-store' }).then(function (r) {
      if (r && r.ok) ok();
    }).catch(function () { /* 仍断线，横幅保持 */ });
  }

  /* ── 按钮 ── */
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.id) return;
    if (t.id === 'cgRetry') {
      t.textContent = '探测中…';
      probe();
      setTimeout(function () { t.textContent = '立即重试'; }, 1200);
    } else if (t.id === 'cgReload') {
      location.reload();
    } else if (t.id === 'cgCopy') {
      var cmd = 'node server/start.js';
      try {
        navigator.clipboard.writeText(cmd).then(function () {
          t.textContent = '已复制 ✓';
          setTimeout(function () { t.textContent = '复制启动命令'; }, 1500);
        }, function () { fallbackCopy(cmd, t); });
      } catch (e) { fallbackCopy(cmd, t); }
    }
  });

  function fallbackCopy(text, btn) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); btn.textContent = '已复制 ✓'; } catch (e) { btn.textContent = '复制失败'; }
    document.body.removeChild(ta);
    setTimeout(function () { btn.textContent = '复制启动命令'; }, 1500);
  }

  /* ── hook fetch：网络层失败才计数（HTTP 4xx/5xx 不算断连） ── */
  try {
    var _fetch = window.fetch;
    window.fetch = function () {
      return _fetch.apply(this, arguments).then(
        function (r) { ok(); return r; },
        function (e) { fail(); throw e; }
      );
    };
  } catch (e) { /* 极旧环境放弃 hook，不影响页面 */ }

  /* ── file:// 立即提示；网络模式等连续失败 2 次再提示 ── */
  if (FILE_MODE) { fails = 2; show(); }
  else { ensureDom(); }
})();
