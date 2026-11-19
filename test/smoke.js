'use strict';
// Смоук-тест: загрузка HTML и ZIP, просмотр, защита от обхода путей, удаление.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
const PASSWORD = 'Test-Password-1234567890X'; // 25 символов
process.env.UPLOAD_PASSWORD = PASSWORD;
const { server } = require('../server');

function makeZip(entries) {
  const locals = []; const centrals = []; let off = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content); const comp = zlib.deflateRawSync(data); const nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp); centrals.push(ch, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const up = (name, body, title = '', pass = PASSWORD) => fetch(`${base}/api/sites`, { method: 'POST', body, headers: { 'X-Filename': encodeURIComponent(name), 'X-Title': encodeURIComponent(title), 'X-Upload-Password': encodeURIComponent(pass) } });

  // без пароля и с неверным паролем загрузка запрещена
  let r0 = await fetch(`${base}/api/sites`, { method: 'POST', body: '<p>x</p>', headers: { 'X-Filename': 'a.html' } });
  assert.strictEqual(r0.status, 401);
  r0 = await up('a.html', '<p>x</p>', '', 'wrong-password-wrong-pass');
  assert.strictEqual(r0.status, 401);

  let r = await up('page.html', '<html><head><title>Привет, мир</title></head><body>hello</body></html>');
  assert.strictEqual(r.status, 201);
  const a = await r.json();
  assert.strictEqual(a.title, 'Привет, мир');
  assert.ok(a.deleteKey);

  r = await fetch(`${base}/s/${a.id}/`);
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /hello/);
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  r = await fetch(`${base}/s/${a.id}`, { redirect: 'manual' });
  assert.strictEqual(r.status, 301);

  const zip = makeZip([['mysite/index.html', '<title>Zip</title><link rel=stylesheet href="css/s.css">'], ['mysite/css/s.css', 'body{color:red}'], ['../evil.txt', 'x']]);
  r = await up('mysite.zip', zip, 'Мой сайт');
  assert.strictEqual(r.status, 201);
  const b = await r.json();
  assert.strictEqual(b.title, 'Мой сайт');
  assert.strictEqual(b.entry, 'index.html');
  r = await fetch(`${base}/s/${b.id}/css/s.css`);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/css/);
  r = await fetch(`${base}/s/${b.id}/..%2fmeta.json`);
  assert.strictEqual(r.status, 404);

  r = await up('x.exe', 'MZ');
  assert.strictEqual(r.status, 400);

  r = await fetch(`${base}/api/sites`);
  assert.strictEqual((await r.json()).length, 2); // неудачные попытки ничего не сохранили

  r = await fetch(`${base}/api/sites/${a.id}`, { method: 'DELETE', headers: { 'X-Delete-Key': 'wrong' } });
  assert.strictEqual(r.status, 403);
  r = await fetch(`${base}/api/sites/${a.id}`, { method: 'DELETE', headers: { 'X-Delete-Key': a.deleteKey } });
  assert.strictEqual(r.status, 204);
  r = await fetch(`${base}/s/${a.id}/`);
  assert.strictEqual(r.status, 404);

  // автогенерация пароля длиной 25 символов, если UPLOAD_PASSWORD не задан
  const { execFileSync } = require('child_process');
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  const env = { ...process.env, DATA_DIR: dir2 }; delete env.UPLOAD_PASSWORD;
  execFileSync(process.execPath, ['-e', "require('./server')"], { cwd: path.join(__dirname, '..'), env });
  const gen = fs.readFileSync(path.join(dir2, 'upload-password.txt'), 'utf8').trim();
  assert.strictEqual(gen.length, 25);
  fs.rmSync(dir2, { recursive: true, force: true });

  console.log('✓ все проверки пройдены');
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
