'use strict';
// Хранилище «бакета» в папке на диске — для локальной разработки и тестов.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

function createFsStorage({ root, putBaseUrl, secret = crypto.randomBytes(16).toString('hex') }) {
  fs.mkdirSync(root, { recursive: true });
  const file = (key) => {
    const f = path.join(root, ...key.split('/'));
    if (!f.startsWith(root + path.sep)) throw new Error('bad key');
    return f;
  };
  const sign = (key) => crypto.createHmac('sha256', secret).update(key).digest('hex');
  async function walk(dir, prefix, out) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const key = prefix + e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), key + '/', out);
      else out.push(key);
    }
  }
  return {
    root,
    file,
    verify: (key, sig) => typeof sig === 'string' && sig.length === 64 && crypto.timingSafeEqual(Buffer.from(sign(key)), Buffer.from(sig)),
    async getJSON(key) {
      try { return JSON.parse(await fsp.readFile(file(key), 'utf8')); } catch { return null; }
    },
    async putJSON(key, obj) {
      await fsp.mkdir(path.dirname(file(key)), { recursive: true });
      await fsp.writeFile(file(key), JSON.stringify(obj, null, 2));
    },
    async list(prefix) {
      const out = [];
      await walk(root, '', out);
      return out.filter((k) => k.startsWith(prefix));
    },
    async deleteMany(keys) {
      for (const k of keys) await fsp.rm(file(k), { force: true });
    },
    async presignPut(key) {
      return `${putBaseUrl}/__put/${key.split('/').map(encodeURIComponent).join('/')}?sig=${sign(key)}`;
    },
  };
}

module.exports = { createFsStorage };
