const fs = require('node:fs');
const path = require('node:path');
const TYPES = {html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'application/javascript; charset=utf-8',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',webp:'image/webp',mp4:'video/mp4',woff2:'font/woff2',json:'application/json; charset=utf-8'};

module.exports = function serveStatic(req, res, pathname, root) {
  if (!['GET','HEAD'].includes(req.method)) return false;
  let rel;
  try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); } catch { return false; }
  if (rel.includes('\0') || rel.includes('\\')) return false;
  const resolvedRoot = path.resolve(root), file = path.resolve(resolvedRoot, '.' + rel);
  if (!file.startsWith(resolvedRoot + path.sep)) return false;
  let stat; try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const headers = {'Content-Type':TYPES[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream','Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff'};
  let start = 0, end = stat.size - 1, status = 200;
  if (req.headers.range && req.method === 'GET') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, {...headers,'Content-Range':`bytes */${stat.size}`,'Content-Length':0}); res.end(); return true;
    }
    if (match[1]) { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]),stat.size-1) : stat.size-1; }
    else { start = Math.max(0,stat.size-Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
      res.writeHead(416, {...headers,'Content-Range':`bytes */${stat.size}`,'Content-Length':0}); res.end(); return true;
    }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = stat.size === 0 ? 0 : end-start+1;
  res.writeHead(status,headers);
  if (req.method === 'HEAD' || stat.size === 0) { res.end(); return true; }
  const stream = fs.createReadStream(file,{start,end});
  stream.on('error',()=>res.destroy()); res.on('close',()=>stream.destroy()); stream.pipe(res); return true;
};
