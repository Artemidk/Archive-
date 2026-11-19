'use strict';
// Тест логики Cloud Function на локальном хранилище.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHandler } = require('../function/handler');
const { createFsStorage } = require('../dev/fsstorage');

const PASSWORD = 'Test-Password-1234567890X';
assert.strictEqual(PASSWORD.length, 25);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
const storage = createFsStorage({ root, putBaseUrl: 'http://bucket' });
const handler = createHandler({ storage, password: PASSWORD });

const call = async (body, method = 'POST') => {
  const r = await handler({ httpMethod: method, body: JSON.stringify(body) });
  return { status: r.statusCode, data: r.body ? JSON.parse(r.body) : null, headers: r.headers };
};
// «загрузка по подписанной ссылке»: проверяем подпись и пишем файл
const put = (url, content) => {
  const u = new URL(url);
  const key = decodeURIComponent(u.pathname.replace(/^\/__put\//, ''));
  assert.ok(storage.verify(key, u.searchParams.get('sig')), 'подпись ссылки');
  const f = storage.file(key);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};

(async () => {
  // неверный пароль, неверный метод, неизвестное действие
  assert.strictEqual((await call({ action: 'start', password: 'x'.repeat(25), entry: 'index.html', files: [{ path: 'index.html', size: 1 }] })).status, 401);
  assert.strictEqual((await call({}, 'GET')).status, 405);
  assert.strictEqual((await call({ action: 'toString' })).status, 400);
  assert.strictEqual((await call({ action: 'start', password: PASSWORD, entry: 'index.html', files: [{ path: '../x.html', size: 1 }] })).status, 400);

  // неправильная длина пароля в настройках функции
  const bad = createHandler({ storage, password: 'short' });
  assert.strictEqual((await bad({ httpMethod: 'POST', body: '{}' })).statusCode, 500);

  // полная загрузка сайта из двух файлов
  let r = await call({
    action: 'start', password: PASSWORD, title: 'Мой сайт', originalName: 'site.zip', entry: 'index.html',
    files: [{ path: 'index.html', size: 10 }, { path: 'css/стиль.css', size: 5 }],
  });
  assert.strictEqual(r.status, 200);
  const { id, uploads } = r.data;
  assert.strictEqual(uploads.length, 2);
  assert.strictEqual(uploads.find((u) => u.path === 'css/стиль.css').contentType, 'text/css; charset=utf-8');

  // commit до загрузки всех файлов — ошибка
  put(uploads[0].url, '<h1>hi</h1>');
  r = await call({ action: 'commit', password: PASSWORD, id });
  assert.strictEqual(r.status, 400);
  put(uploads[1].url, 'body{}');
  r = await call({ action: 'commit', password: PASSWORD, id });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.deleteKey);
  assert.strictEqual(r.data.title, 'Мой сайт');
  const deleteKey = r.data.deleteKey;
  assert.strictEqual((await call({ action: 'commit', password: PASSWORD, id })).status, 409);

  let index = await storage.getJSON('index.json');
  assert.strictEqual(index.length, 1);
  assert.strictEqual(index[0].deleteKeyHash, undefined);
  assert.strictEqual(index[0].status, undefined);

  // второй сайт, удаление паролем
  r = await call({ action: 'start', password: PASSWORD, entry: 'page.html', files: [{ path: 'page.html', size: 3 }] });
  put(r.data.uploads[0].url, 'abc');
  const id2 = r.data.id;
  assert.strictEqual((await call({ action: 'commit', password: PASSWORD, id: id2 })).status, 200);
  assert.strictEqual((await storage.getJSON('index.json')).length, 2);

  // reindex восстанавливает список
  await storage.putJSON('index.json', []);
  assert.strictEqual((await call({ action: 'reindex', password: PASSWORD })).data.count, 2);

  // удаление: чужой ключ — нельзя; свой ключ — можно; пароль — можно
  assert.strictEqual((await call({ action: 'delete', id, key: 'wrong' })).status, 403);
  assert.strictEqual((await call({ action: 'delete', id, key: deleteKey })).status, 200);
  assert.strictEqual((await call({ action: 'delete', id: id2, password: PASSWORD })).status, 200);
  assert.deepStrictEqual(await storage.list('s/'), []);
  assert.deepStrictEqual(await storage.getJSON('index.json'), []);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('✓ все проверки пройдены');
})().catch((e) => { console.error(e); process.exit(1); });
