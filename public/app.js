'use strict';
const $ = (s) => document.querySelector(s);
const CFG = window.ARCHIVE_CONFIG || {};
const SITES = (CFG.sitesUrl || '').replace(/\/+$/, '');

// ---------- localStorage (может быть недоступен) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const KEYS = 'archive-delete-keys';
const PASS = 'archive-upload-password';
const loadKeys = () => { try { return JSON.parse(store.get(KEYS)) || {}; } catch { return {}; } };
const saveKey = (id, key) => { const k = loadKeys(); k[id] = key; store.set(KEYS, JSON.stringify(k)); };
const dropKey = (id) => { const k = loadKeys(); delete k[id]; store.set(KEYS, JSON.stringify(k)); };

if (store.get(PASS)) { $('#password').value = store.get(PASS); $('#remember').checked = true; }
$('#remember').addEventListener('change', (e) => { if (!e.target.checked) store.del(PASS); });

// ---------- утилиты ----------
const fmtSize = (n) => n < 1024 ? `${n} Б` : n < 1048576 ? `${(n / 1024).toFixed(1)} КБ` : `${(n / 1048576).toFixed(1)} МБ`;
const fmtDate = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const siteUrl = (s) => `${SITES}/s/${s.id}/${s.entry && s.entry !== 'index.html' ? encPath(s.entry) : ''}`;
const DROP_HTML = '<b>Перетащите файл сюда</b> или нажмите, чтобы выбрать<br><small>.html, .htm или .zip (сайт с картинками и стилями)</small>';

function msg(text, cls = '', link) {
  const el = $('#msg');
  el.className = 'msg ' + cls;
  el.textContent = text;
  if (link) {
    const a = document.createElement('a');
    a.href = link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = link;
    el.append(' ', a);
  }
}
const setProgress = (frac) => {
  $('#progress').hidden = frac === null;
  if (frac !== null) $('#progress').firstElementChild.style.width = `${Math.round(frac * 100)}%`;
};

async function api(action, data) {
  const r = await fetch(CFG.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, // «простой» запрос — без preflight
    body: JSON.stringify({ action, ...data }),
  });
  let body = {};
  try { body = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(body.error || `Ошибка сервера (${r.status})`), { status: r.status });
  return body;
}

function extractTitle(bytes) {
  const html = new TextDecoder('utf-8').decode(bytes.subarray(0, 200000));
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return '';
  const t = document.createElement('textarea');
  t.innerHTML = m[1];
  return t.value.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Превращает выбранный файл в список файлов сайта и точку входа. */
async function prepare(file) {
  const buf = await file.arrayBuffer();
  if (/\.html?$/i.test(file.name)) {
    const data = new Uint8Array(buf);
    return { files: [{ path: 'index.html', data }], entry: 'index.html', title: extractTitle(data) };
  }
  let files = (await window.unzipFile(buf))
    .filter((f) => !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/.test(f.name))
    .map((f) => ({ path: f.name.replace(/\\/g, '/').replace(/^\/+/, ''), data: f.data }))
    .filter((f) => f.path && !f.path.split('/').includes('..'));
  if (!files.length) throw new Error('Архив пуст');
  const first = files[0].path.split('/')[0];
  if (files.every((f) => f.path.includes('/') && f.path.split('/')[0] === first)) {
    files = files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
  }
  const htmls = files.map((f) => f.path).filter((n) => /\.html?$/i.test(n))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const entry = htmls.find((n) => /^index\.html?$/i.test(n)) || htmls[0];
  if (!entry) throw new Error('В архиве нет ни одного HTML-файла');
  return { files, entry, title: extractTitle(files.find((f) => f.path === entry).data) };
}

function putFile(url, data, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Хранилище ответило ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('Не удалось отправить файл в хранилище (проверьте CORS бакета)'));
    xhr.send(new Blob([data]));
  });
}

// ---------- выбор файла ----------
let file = null;
function pick(f) {
  if (!f) return;
  if (!/\.(html?|zip)$/i.test(f.name)) { msg('Нужен файл .html, .htm или .zip', 'err'); return; }
  file = f;
  const b = document.createElement('b'); b.textContent = f.name;
  const s = document.createElement('small'); s.textContent = ` · ${fmtSize(f.size)} — нажмите, чтобы выбрать другой`;
  $('#drop-text').replaceChildren(b, s);
  $('#submit').disabled = false;
  msg('');
}
$('#file').addEventListener('change', (e) => pick(e.target.files[0]));
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => pick(e.dataTransfer.files[0]));

// ---------- загрузка ----------
$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!file) return;
  const password = $('#password').value;
  if (password.length !== 25) { msg(`Пароль должен быть длиной 25 символов (сейчас ${password.length})`, 'err'); $('#password').focus(); return; }
  $('#submit').disabled = true;
  try {
    msg('Подготовка файлов…');
    const site = await prepare(file);
    const total = site.files.reduce((n, f) => n + f.data.length, 0) || 1;

    msg('Проверка пароля…');
    const { id, uploads } = await api('start', {
      password,
      title: $('#title').value || site.title || file.name.replace(/\.[^.]+$/, ''),
      description: $('#desc').value,
      originalName: file.name,
      entry: site.entry,
      files: site.files.map((f) => ({ path: f.path, size: f.data.length })),
    });
    if (!$('#remember').checked) store.del(PASS); else store.set(PASS, password);

    msg(`Загрузка ${site.files.length > 1 ? `${site.files.length} файлов` : 'файла'}…`);
    const byPath = new Map(site.files.map((f) => [f.path, f]));
    const loaded = new Map();
    const tick = () => setProgress([...loaded.values()].reduce((a, b) => a + b, 0) / total);
    setProgress(0);
    const queue = [...uploads];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const u = queue.shift();
        const f = byPath.get(u.path);
        await putFile(u.url, f.data, u.contentType, (n) => { loaded.set(u.path, n); tick(); });
        loaded.set(u.path, f.data.length); tick();
      }
    }));

    msg('Сохранение…');
    const meta = await api('commit', { password, id });
    saveKey(meta.id, meta.deleteKey);
    delete meta.deleteKey;
    sites = [meta, ...sites.filter((s) => s.id !== meta.id)];
    render();
    msg('Сохранено! Постоянная ссылка:', 'ok', siteUrl(meta));
    file = null;
    $('#file').value = ''; $('#title').value = ''; $('#desc').value = '';
    $('#drop-text').innerHTML = DROP_HTML;
  } catch (err) {
    msg(err.message || 'Ошибка загрузки', 'err');
    if (err.status === 401) { store.del(PASS); $('#password').select(); }
    $('#submit').disabled = false;
  } finally {
    setProgress(null);
  }
});

// ---------- список ----------
let sites = [];

function render() {
  const q = $('#search').value.trim().toLowerCase();
  const keys = loadKeys();
  const shown = sites.filter((s) => !q || `${s.title} ${s.description} ${s.originalName}`.toLowerCase().includes(q));
  $('#count').textContent = sites.length ? `· ${sites.length}` : '';
  $('#empty').hidden = shown.length > 0;
  $('#empty').textContent = sites.length ? 'Ничего не найдено.' : 'Пока здесь пусто — загрузите первый сайт.';
  $('#list').replaceChildren(...shown.map((s) => {
    const el = $('#tpl').content.firstElementChild.cloneNode(true);
    const url = siteUrl(s);
    el.querySelector('.thumb').href = url;
    el.querySelector('iframe').src = url;
    el.querySelector('iframe').title = `Превью: ${s.title}`;
    el.querySelector('.name').href = url;
    el.querySelector('.name').textContent = s.title || 'Без названия';
    el.querySelector('.desc').textContent = s.description || '';
    el.querySelector('.meta').textContent = `${fmtDate(s.createdAt)} · ${s.originalName} · ${fmtSize(s.size)}${s.fileCount > 1 ? ` · ${s.fileCount} файлов` : ''}`;
    el.querySelector('.open').href = url;
    const copy = el.querySelector('.copy');
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(url); copy.textContent = 'Скопировано ✓'; }
      catch { prompt('Ссылка на сайт:', url); }
      setTimeout(() => (copy.textContent = 'Ссылка'), 1500);
    };
    const del = el.querySelector('.del');
    const pass = $('#password').value;
    if (keys[s.id] || pass.length === 25) {
      del.hidden = false;
      del.onclick = async () => {
        if (!confirm(`Удалить «${s.title}» из архива? Это нельзя отменить.`)) return;
        try {
          await api('delete', { id: s.id, key: keys[s.id], password: $('#password').value });
        } catch (err) {
          if (err.status !== 404) { alert(err.message); return; }
        }
        dropKey(s.id);
        sites = sites.filter((x) => x.id !== s.id);
        render();
      };
    }
    return el;
  }));
}

$('#search').addEventListener('input', render);
$('#password').addEventListener('input', () => { if ([24, 25, 26].includes($('#password').value.length)) render(); });

if (!CFG.apiUrl || !SITES) {
  $('#setup').hidden = false;
  $('#submit').title = 'Архив не настроен';
} else {
  fetch(`${SITES}/index.json?t=${Date.now()}`, { cache: 'no-store' })
    .then((r) => (r.status === 404 || r.status === 403 ? [] : r.json()))
    .then((d) => { sites = Array.isArray(d) ? d : []; render(); })
    .catch(() => msg('Не удалось загрузить список сайтов', 'err'));
}
