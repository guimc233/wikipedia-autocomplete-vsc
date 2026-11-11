'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');

const URL = 'https://dumps.wikimedia.org/zhwiki/latest/zhwiki-latest-all-titles-in-ns0.gz';
const HEADER = Buffer.from('page_title\n');
const WINDOW = 2048;

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'WikipediaLinkPicker/0.1 (VS Code extension)', 'Accept': 'application/octet-stream' }, timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        const next = new globalThis.URL(res.headers.location, url);
        if (next.protocol !== 'https:') return reject(new Error('下载地址必须使用 HTTPS'));
        request(next.href, redirects + 1).then(resolve, reject);
      } else if (res.statusCode !== 200) {
        res.resume(); reject(new Error(`下载失败：HTTP ${res.statusCode}`));
      } else resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

async function downloadIndex(directory, token, report) {
  await fsp.mkdir(directory, { recursive: true });
  const dest = path.join(directory, 'zhwiki-titles.txt');
  const tmp = path.join(directory, `zhwiki-titles-${process.pid}-${Date.now()}.tmp`);
  let response;
  let cancelled = token.isCancellationRequested;
  const cancellation = token.onCancellationRequested(() => { cancelled = true; if (response) response.destroy(new Error('下载已取消')); });
  try {
    if (cancelled) throw new Error('下载已取消');
    response = await request(URL);
    if (cancelled) throw new Error('下载已取消');
    let bytes = 0;
    const total = Number(response.headers['content-length']);
    let last = 0;
    response.on('data', chunk => {
      bytes += chunk.length;
      const percent = total ? Math.floor(bytes * 100 / total) : 0;
      if (percent > last) { report({ increment: percent - last, message: `${percent}%` }); last = percent; }
    });
    await pipeline(response, zlib.createGunzip(), fs.createWriteStream(tmp, { flags: 'wx' }));
    const file = await fsp.open(tmp, 'r');
    try {
      const header = Buffer.alloc(HEADER.length);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      const stat = await file.stat();
      if (bytesRead !== HEADER.length || !header.equals(HEADER) || stat.size <= HEADER.length) throw new Error('标题文件格式不正确');
    } finally { await file.close(); }
    if (cancelled) throw new Error('下载已取消');
    await fsp.rename(tmp, dest);
    return dest;
  } finally {
    cancellation.dispose();
    if (response && !response.destroyed) response.destroy();
    await fsp.rm(tmp, { force: true });
  }
}

async function lowerBound(file, size, needle) {
  let lo = HEADER.length, hi = size;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const start = Math.max(HEADER.length, mid - WINDOW);
    const length = Math.min(size - start, WINDOW * 2);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await file.read(buf, 0, length, start);
    const data = buf.subarray(0, bytesRead);
    const before = data.lastIndexOf(10, Math.max(0, mid - start - 1));
    const lineStart = before < 0 ? start : start + before + 1;
    if (before < 0 && start !== HEADER.length) throw new Error('索引中的标题过长');
    const rel = lineStart - start;
    const end = data.indexOf(10, rel);
    if (end < 0 && start + bytesRead < size) throw new Error('索引中的标题过长');
    const lineEnd = end < 0 ? start + bytesRead : start + end;
    if (Buffer.compare(data.subarray(rel, end < 0 ? bytesRead : end), needle) < 0) lo = Math.min(size, lineEnd + 1);
    else hi = lineStart;
  }
  return lo;
}

async function search(indexPath, query, limit = 30) {
  query = query.trim().replace(/ /g, '_');
  if (!query || /[\r\n]/.test(query)) return [];
  const file = await fsp.open(indexPath, 'r');
  try {
    const { size } = await file.stat();
    const variants = [...new Set([query, query[0].toUpperCase() + query.slice(1)])];
    const found = new Set();
    for (const variant of variants) {
      const prefix = Buffer.from(variant);
      let pos = await lowerBound(file, size, prefix);
      let pending = Buffer.alloc(0);
      let matchedRangeEnded = false;
      while (pos < size && found.size < limit && !matchedRangeEnded) {
        const buf = Buffer.alloc(Math.min(65536, size - pos));
        const { bytesRead } = await file.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        const data = Buffer.concat([pending, buf.subarray(0, bytesRead)]);
        let offset = 0, end;
        while ((end = data.indexOf(10, offset)) !== -1) {
          const line = data.subarray(offset, end);
          if (!line.subarray(0, prefix.length).equals(prefix)) { matchedRangeEnded = true; break; }
          found.add(line.toString('utf8').replace(/_/g, ' '));
          if (found.size >= limit) return [...found];
          offset = end + 1;
        }
        pending = matchedRangeEnded ? Buffer.alloc(0) : data.subarray(offset);
      }
      if (pending.length && pending.subarray(0, prefix.length).equals(prefix)) found.add(pending.toString('utf8').replace(/_/g, ' '));
    }
    return [...found].sort((a, b) => (a.toLowerCase() === query.replace(/_/g, ' ').toLowerCase() ? -1 : 0) - (b.toLowerCase() === query.replace(/_/g, ' ').toLowerCase() ? -1 : 0));
  } finally { await file.close(); }
}

module.exports = { downloadIndex, search, URL };
