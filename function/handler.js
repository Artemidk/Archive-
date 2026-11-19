'use strict';
/*
 * Логика Cloud Function архива. Не зависит от конкретного хранилища:
 * storage передаётся снаружи (Object Storage в облаке, папка на диске локально).
 *
 * Все запросы — POST с JSON в теле (Content-Type: text/plain, чтобы браузер
 * не делал preflight-запрос). Поле action выбирает операцию:
 *   start   — проверка пароля, выдача подписанных ссылок для загрузки файлов
 *   commit  — завершение загрузки, сайт появляется в списке
 *   delete  — удаление сайта (ключ удаления или пароль на загрузку)
 *   reindex — пересобрать index.json по метаданным (пароль)
 *
 * Раскладка в бакете с сайтами:
 *   s/<id>/...          — файлы сайта (публичные)
 *   _meta/<id>.json     — метаданные сайта
 *   index.json          — список готовых сайтов для интерфейса
 */
const crypto = require('crypto');

const PASSWORD_LENGTH = 25;
const MAX_FILES = 5000;

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
const hashHex = (s) => hash(s).toString('hex');
const isValidId = (id) => typeof id === 'string' && /^[a-z0-9]{10}$/.test(id);

function newId() {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(10), (b) => a[b % a.length]).join('');
}

/** Нормализует путь файла внутри сайта; null — если путь опасен. */
function safeRel(p) {
  if (typeof p !== 'string' || p.length > 512) return null;
  const parts = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..' || /[\0-\x1f]/.test(seg)) return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4',
  webm: 'video/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf',
  wasm: 'application/wasm', map: 'application/json',
};
const mimeOf = (p) => MIME[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function createHandler({ storage, password, uiOrigin = '*', maxTotalMb = 200 }) {
  const passwordOk = typeof password === 'string' && password.length === PASSWORD_LENGTH;
  const passwordHash = passwordOk ? hash(password) : null;
  const MAX_TOTAL = maxTotalMb * 1024 * 1024;

  const checkPassword = (given) => passwordOk && crypto.timingSafeEqual(hash(given || ''), passwordHash);

  const publicMeta = ({ deleteKeyHash, status, ...m }) => m;

  async function readIndex() {
    return (await storage.getJSON('index.json')) || [];
  }
  async function writeIndex(list) {
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    await storage.putJSON('index.json', list);
  }

  const actions = {
    async start(body) {
      if (!checkPassword(body.password)) return [401, { error: 'Неверный пароль для загрузки' }];
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length) return [400, { error: 'Нет файлов для загрузки' }];
      if (files.length > MAX_FILES) return [400, { error: `Слишком много файлов (больше ${MAX_FILES})` }];
      const clean = [];
      const seen = new Set();
      let total = 0;
      for (const f of files) {
        const path = safeRel(f && f.path);
        const size = Number(f && f.size);
        if (!path || !Number.isFinite(size) || size < 0) return [400, { error: `Недопустимое имя файла: ${String(f && f.path).slice(0, 100)}` }];
        if (seen.has(path)) continue;
        seen.add(path);
        total += size;
        clean.push({ path, size, type: mimeOf(path) });
      }
      if (total > MAX_TOTAL) return [400, { error: `Сайт больше ${maxTotalMb} МБ` }];
      const entry = safeRel(body.entry);
      if (!entry || !seen.has(entry) || !/\.html?$/i.test(entry)) return [400, { error: 'Не найдена HTML-страница сайта' }];

      const id = newId();
      const meta = {
        id,
        title: str(body.title, 200) || 'Без названия',
        description: str(body.description, 1000),
        originalName: str(body.originalName, 255),
        entry,
        fileCount: clean.length,
        size: total,
        createdAt: new Date().toISOString(),
        status: 'pending',
        files: clean.map((f) => f.path),
      };
      await storage.putJSON(`_meta/${id}.json`, meta);
      const uploads = await Promise.all(clean.map(async (f) => ({
        path: f.path,
        contentType: f.type,
        url: await storage.presignPut(`s/${id}/${f.path}`, f.type),
      })));
      return [200, { id, uploads }];
    },

    async commit(body) {
      if (!checkPassword(body.password)) return [401, { error: 'Неверный пароль для загрузки' }];
      if (!isValidId(body.id)) return [400, { error: 'Неверный id' }];
      const meta = await storage.getJSON(`_meta/${body.id}.json`);
      if (!meta) return [404, { error: 'Загрузка не найдена' }];
      if (meta.status !== 'pending') return [409, { error: 'Загрузка уже завершена' }];
      const present = new Set((await storage.list(`s/${meta.id}/`)).map((k) => k.slice(`s/${meta.id}/`.length)));
      const missing = meta.files.filter((p) => !present.has(p));
      if (missing.length) return [400, { error: `Не загружены файлы: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}` }];

      const deleteKey = crypto.randomBytes(18).toString('base64url');
      delete meta.files;
      meta.status = 'ready';
      meta.deleteKeyHash = hashHex(deleteKey);
      await storage.putJSON(`_meta/${meta.id}.json`, meta);
      const list = (await readIndex()).filter((m) => m.id !== meta.id);
      list.push(publicMeta(meta));
      await writeIndex(list);
      return [200, { ...publicMeta(meta), deleteKey }];
    },

    async delete(body) {
      if (!isValidId(body.id)) return [400, { error: 'Неверный id' }];
      const meta = await storage.getJSON(`_meta/${body.id}.json`);
      if (!meta) return [404, { error: 'Сайт не найден' }];
      const byKey = typeof body.key === 'string' && meta.deleteKeyHash && hashHex(body.key) === meta.deleteKeyHash;
      if (!byKey && !checkPassword(body.password)) return [403, { error: 'Нет прав на удаление' }];
      await storage.deleteMany(await storage.list(`s/${meta.id}/`));
      await storage.deleteMany([`_meta/${meta.id}.json`]);
      await writeIndex((await readIndex()).filter((m) => m.id !== meta.id));
      return [200, { ok: true }];
    },

    async reindex(body) {
      if (!checkPassword(body.password)) return [401, { error: 'Неверный пароль' }];
      const list = [];
      for (const key of await storage.list('_meta/')) {
        const m = await storage.getJSON(key);
        if (m && m.status === 'ready') list.push(publicMeta(m));
      }
      await writeIndex(list);
      return [200, { count: list.length }];
    },
  };

  return async function handler(event) {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': uiOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
    };
    const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
    if (event.httpMethod !== 'POST') return reply(405, { error: 'Только POST' });
    if (!passwordOk) return reply(500, { error: `Функция не настроена: UPLOAD_PASSWORD должен быть длиной ${PASSWORD_LENGTH} символов` });

    let body;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
      body = JSON.parse(raw);
    } catch {
      return reply(400, { error: 'Некорректный JSON' });
    }
    const action = body && actions[body.action];
    if (!action || !Object.prototype.hasOwnProperty.call(actions, body.action)) return reply(400, { error: 'Неизвестное действие' });
    try {
      const [status, data] = await action(body);
      return reply(status, data);
    } catch (e) {
      console.error(e);
      return reply(500, { error: 'Ошибка хранилища, попробуйте ещё раз' });
    }
  };
}

module.exports = { createHandler, safeRel, PASSWORD_LENGTH };
