'use strict';
/*
 * Архив сайтов — сервер без внешних зависимостей.
 *
 *   GET    /                    — интерфейс архива
 *   GET    /api/sites           — список сохранённых сайтов
 *   POST   /api/sites           — загрузка (тело = файл .html/.htm/.zip)
 *   DELETE /api/sites/:id       — удаление (нужен ключ, выданный при загрузке)
 *   GET    /s/:id/...           — просмотр сохранённого сайта
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { unzip } = require('./lib/unzip');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const SITES_DIR = path.join(DATA_DIR, 'sites');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 50;
const MAX_UPLOAD = MAX_UPLOAD_MB * 1024 * 1024;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(SITES_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.bmp': 'image/bmp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.map': 'application/json',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

// Загруженные сайты открываются в «песочнице»: у них непрозрачный origin,
// поэтому их скрипты не могут обращаться к API архива от имени посетителя.
const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation';

// ---------- хранилище ----------
let cache = null; // массив метаданных

async function loadAll() {
  if (cache) return cache;
  const out = [];
  for (const id of await fsp.readdir(SITES_DIR)) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(SITES_DIR, id, 'meta.json'), 'utf8'));
      out.push(meta);
    } catch { /* пропускаем повреждённые записи */ }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  cache = out;
  return cache;
}

const publicMeta = ({ deleteKeyHash, ...m }) => m;
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isValidId = (id) => /^[a-z0-9]{10}$/.test(id);
const newId = () => {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(10), (b) => a[b % a.length]).join('');
};

/** Нормализует путь внутри сайта; null — если путь опасен. */
function safeRel(p) {
  const parts = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..' || seg.includes('\0') || /^[a-zA-Z]:$/.test(seg)) return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return '';
  return m[1].replace(/\s+/g, ' ').trim()
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").slice(0, 200);
}

function decodeHtml(buf) {
  // учитываем BOM, иначе UTF-8 — нужно только для извлечения заголовка
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  return buf.toString('utf8');
}

/** Превращает загруженный файл в набор файлов сайта и точку входа. */
function buildFiles(filename, body) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.html' || ext === '.htm') {
    return { files: [{ name: 'index.html', data: body }], entry: 'index.html' };
  }
  if (ext === '.zip') {
    let files = unzip(body, { maxTotal: MAX_UPLOAD * 4 })
      .filter((f) => !/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(f.name))
      .map((f) => ({ name: safeRel(f.name), data: f.data }))
      .filter((f) => f.name);
    if (!files.length) throw new Error('Архив пуст');
    // если всё лежит в одной общей папке — убираем её
    const first = files[0].name.split('/')[0];
    if (files.every((f) => f.name.includes('/') && f.name.split('/')[0] === first)) {
      files = files.map((f) => ({ ...f, name: f.name.slice(first.length + 1) }));
    }
    const htmls = files.map((f) => f.name).filter((n) => /\.html?$/i.test(n))
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    const entry = htmls.find((n) => /^index\.html?$/i.test(n)) || htmls[0];
    if (!entry) throw new Error('В архиве нет ни одного HTML-файла');
    return { files, entry };
  }
  throw new Error('Поддерживаются только файлы .html, .htm и .zip');
}

async function saveSite({ filename, title, description, body }) {
  const list = await loadAll(); // прогреваем кэш до записи на диск, чтобы не задвоить запись
  const { files, entry } = buildFiles(filename, body);
  const entryFile = files.find((f) => f.name === entry);
  const id = newId();
  const dir = path.join(SITES_DIR, id);
  const filesDir = path.join(dir, 'files');
  let size = 0;
  for (const f of files) {
    const target = path.join(filesDir, f.name);
    if (!target.startsWith(filesDir + path.sep)) continue;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, f.data);
    size += f.data.length;
  }
  const deleteKey = crypto.randomBytes(18).toString('base64url');
  const meta = {
    id,
    title: (title || extractTitle(decodeHtml(entryFile.data)) || filename.replace(/\.[^.]+$/, '')).slice(0, 200),
    description: (description || '').slice(0, 1000),
    originalName: filename.slice(0, 255),
    entry,
    fileCount: files.length,
    size,
    createdAt: new Date().toISOString(),
    deleteKeyHash: hash(deleteKey),
  };
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  list.unshift(meta);
  return { ...publicMeta(meta), deleteKey };
}

async function deleteSite(id, key) {
  const list = await loadAll();
  const i = list.findIndex((m) => m.id === id);
  if (i < 0) return 404;
  const okKey = key && hash(key) === list[i].deleteKeyHash;
  const okAdmin = ADMIN_TOKEN && key === ADMIN_TOKEN;
  if (!okKey && !okAdmin) return 403;
  await fsp.rm(path.join(SITES_DIR, id), { recursive: true, force: true });
  list.splice(i, 1);
  return 204;
}

// ---------- HTTP ----------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
const sendJSON = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > limit) { reject(Object.assign(new Error(`Файл больше ${MAX_UPLOAD_MB} МБ`), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const hdr = (req, name) => {
  const v = req.headers[name];
  if (!v) return '';
  try { return decodeURIComponent(v); } catch { return ''; }
};

async function serveFile(req, res, file, extraHeaders = {}) {
  let st;
  try { st = await fsp.stat(file); } catch { return false; }
  if (!st.isFile()) return false;
  const etag = `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
  const headers = { 'Content-Type': mimeOf(file), ETag: etag, ...extraHeaders };
  if (req.headers['if-none-match'] === etag) { send(res, 304, null, headers); return true; }
  res.writeHead(200, { 'X-Content-Type-Options': 'nosniff', 'Content-Length': st.size, ...headers });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}

async function serveSite(req, res, id, rest) {
  if (!isValidId(id)) return send(res, 404, 'Not found');
  const meta = (await loadAll()).find((m) => m.id === id);
  if (!meta) return send(res, 404, 'Сайт не найден', { 'Content-Type': 'text/plain; charset=utf-8' });
  if (rest === null) { // /s/id → /s/id/ чтобы работали относительные ссылки
    return send(res, 301, null, { Location: `/s/${id}/` });
  }
  const rel = rest === '' ? meta.entry : safeRel(rest);
  if (!rel) return send(res, 404, 'Not found');
  const base = path.join(SITES_DIR, id, 'files');
  const headers = { 'Content-Security-Policy': SANDBOX_CSP, 'Cache-Control': 'public, max-age=300', 'Referrer-Policy': 'no-referrer' };
  const candidates = [rel, rel + '/index.html', rel + '/index.htm', rel + '.html'];
  for (const c of candidates) {
    const f = path.join(base, c);
    if (!f.startsWith(base + path.sep)) continue;
    if (await serveFile(req, res, f, headers)) return;
  }
  send(res, 404, 'Файл не найден в сохранённом сайте', { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request'); }

  if (pathname === '/api/sites' && req.method === 'GET') {
    return sendJSON(res, 200, (await loadAll()).map(publicMeta));
  }
  if (pathname === '/api/sites' && req.method === 'POST') {
    const filename = path.basename(hdr(req, 'x-filename') || 'site.html');
    const body = await readBody(req, MAX_UPLOAD);
    if (!body.length) return sendJSON(res, 400, { error: 'Пустой файл' });
    try {
      const site = await saveSite({ filename, title: hdr(req, 'x-title').trim(), description: hdr(req, 'x-description').trim(), body });
      return sendJSON(res, 201, site);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }
  let m = /^\/api\/sites\/([^/]+)$/.exec(pathname);
  if (m && req.method === 'DELETE') {
    const status = await deleteSite(m[1], req.headers['x-delete-key'] || '');
    if (status === 204) return send(res, 204, null);
    return sendJSON(res, status, { error: status === 404 ? 'Сайт не найден' : 'Неверный ключ удаления' });
  }
  if (m && req.method === 'GET') {
    const meta = (await loadAll()).find((x) => x.id === m[1]);
    return meta ? sendJSON(res, 200, publicMeta(meta)) : sendJSON(res, 404, { error: 'Сайт не найден' });
  }
  m = /^\/s\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    return serveSite(req, res, m[1], m[2] === undefined ? null : m[2]);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const rel = pathname === '/' ? 'index.html' : safeRel(pathname);
    if (rel) {
      const f = path.join(PUBLIC_DIR, rel);
      if (f.startsWith(PUBLIC_DIR + path.sep) && await serveFile(req, res, f, { 'Cache-Control': 'no-cache' })) return;
    }
  }
  send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) sendJSON(res, e.status || 500, { error: e.status ? e.message : 'Внутренняя ошибка сервера' });
    if (!e.status) console.error(e);
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Архив сайтов запущен: http://localhost:${PORT}`);
    console.log(`Данные хранятся в ${DATA_DIR}`);
  });
}

module.exports = { server };
