'use strict';
/*
 * Локальный эмулятор облака для разработки:
 *   http://localhost:3000      — интерфейс (бакет с UI)
 *   http://localhost:3000/api  — Cloud Function
 *   http://localhost:3001      — бакет с сайтами (как *.website.yandexcloud.net)
 * Пароль берётся из UPLOAD_PASSWORD или генерируется и печатается.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createHandler } = require('../function/handler');
const { createFsStorage } = require('./fsstorage');

const UI_PORT = Number(process.env.UI_PORT) || 3000;
const SITES_PORT = Number(process.env.SITES_PORT) || 3001;
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC = path.join(__dirname, '..', 'public');
const password = process.env.UPLOAD_PASSWORD || crypto.randomBytes(32).toString('base64url').slice(0, 25);

const storage = createFsStorage({ root: DATA, putBaseUrl: `http://localhost:${SITES_PORT}` });
const handler = createHandler({ storage, password, uiOrigin: `http://localhost:${UI_PORT}` });

const MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const mime = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
  });
}

// --- интерфейс + функция ---
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api') {
    const body = await readBody(req);
    const r = await handler({ httpMethod: req.method, headers: req.headers, body: body.toString('base64'), isBase64Encoded: true });
    res.writeHead(r.statusCode, r.headers);
    return res.end(r.body);
  }
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    return res.end(`window.ARCHIVE_CONFIG = ${JSON.stringify({ apiUrl: `http://localhost:${UI_PORT}/api`, sitesUrl: `http://localhost:${SITES_PORT}` })};`);
  }
  const f = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!f.startsWith(PUBLIC + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': mime(f), 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}).listen(UI_PORT);

// --- бакет с сайтами (веб-хостинг + подписанные PUT) ---
http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, HEAD', 'Access-Control-Allow-Headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(200, cors); return res.end(); }
  const url = new URL(req.url, 'http://x');
  let key;
  try { key = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { res.writeHead(400, cors); return res.end(); }
  if (req.method === 'PUT' && key.startsWith('__put/')) {
    key = key.slice(6);
    if (!storage.verify(key, url.searchParams.get('sig'))) { res.writeHead(403, cors); return res.end('SignatureDoesNotMatch'); }
    const body = await readBody(req);
    const f = storage.file(key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
    res.writeHead(200, cors); return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, cors); return res.end(); }
  let f;
  try { f = storage.file(key || 'index.html'); } catch { res.writeHead(404, cors); return res.end(); }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404, { ...cors, 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<h1>404 Not Found</h1>'); }
  res.writeHead(200, { ...cors, 'Content-Type': mime(f), 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}).listen(SITES_PORT);

console.log(`Интерфейс:        http://localhost:${UI_PORT}`);
console.log(`Бакет с сайтами:  http://localhost:${SITES_PORT}`);
console.log(`Пароль загрузки:  ${password}`);
