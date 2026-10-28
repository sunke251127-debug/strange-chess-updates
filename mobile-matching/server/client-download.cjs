'use strict';

const fs = require('node:fs');
const { pipeline } = require('node:stream');
const { version } = require('../package.json');
const DOWNLOAD_NAME = `strange-chess-${version}-windows-x64.exe`;

// Only the explicitly configured distributable is public. Never resolve a
// request path against the installation directory or expose the user's profile.
function createClientDownload(filePath) {
  return async function handleClientDownload(req, res, pathname) {
    if (pathname !== '/api/client' && pathname !== '/download/windows') return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let file;
    try {
      if (filePath) file = await fs.promises.open(filePath, 'r');
      const stat = file && await file.stat();
      if (!stat?.isFile() || stat.size === 0) {
        if (file) await file.close();
        file = null;
      }
      if (pathname === '/api/client') {
        const payload = JSON.stringify({
          available: Boolean(file), version, platform: 'windows-x64',
          downloadUrl: file ? '/download/windows' : null,
          filename: file ? DOWNLOAD_NAME : null, bytes: file ? stat.size : 0
        });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(payload));
        res.statusCode = 200;
        res.end(req.method === 'HEAD' ? undefined : payload);
        return true;
      }
      if (!file) {
        res.statusCode = 404;
        res.end(req.method === 'HEAD' ? undefined : 'Windows client unavailable');
        return true;
      }
      let start = 0;
      let end = stat.size - 1;
      res.statusCode = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (match && (match[1] || match[2])) {
          if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
          else start = Number(match[1]);
          if (match[1] && match[2]) end = Math.min(end, Number(match[2]));
        }
        if (!match || !(match[1] || match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
          res.statusCode = 416;
          res.setHeader('Content-Range', `bytes */${stat.size}`);
          res.end();
          return true;
        }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${DOWNLOAD_NAME}"`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', end - start + 1);
      if (req.method === 'HEAD') {
        res.end();
      } else {
        const stream = file.createReadStream({ start, end, autoClose: true });
        file = null; // The stream now owns the descriptor, including on abort.
        pipeline(stream, res, () => {});
      }
      return true;
    } catch {
      if (!res.headersSent) {
        if (pathname === '/api/client') {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.statusCode = 200;
          res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ available: false, version, platform: 'windows-x64', downloadUrl: null, filename: null, bytes: 0 }));
        } else {
          res.statusCode = 404;
          res.end(req.method === 'HEAD' ? undefined : 'Windows client unavailable');
        }
      } else res.destroy();
      return true;
    } finally {
      if (file) await file.close().catch(() => {});
    }
  };
}

module.exports = { createClientDownload };
