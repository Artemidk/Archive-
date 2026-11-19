'use strict';
const $ = (s) => document.querySelector(s);
const KEYS = 'archive-delete-keys';
const loadKeys = () => { try { return JSON.parse(localStorage.getItem(KEYS)) || {}; } catch { return {}; } };
const saveKey = (id, key) => { try { const k = loadKeys(); k[id] = key; localStorage.setItem(KEYS, JSON.stringify(k)); } catch {} };
const dropKey = (id) => { try { const k = loadKeys(); delete k[id]; localStorage.setItem(KEYS, JSON.stringify(k)); } catch {} };

let sites = [];
let file = null;

const fmtSize = (n) => n < 1024 ? `${n} Б` : n < 1048576 ? `${(n / 1024).toFixed(1)} КБ` : `${(n / 1048576).toFixed(1)} МБ`;
const fmtDate = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const siteUrl = (id) => `${location.origin}/s/${id}/`;

function msg(text, cls = '', html = false) {
  const el = $('#msg');
  el.className = 'msg ' + cls;
  if (html) el.innerHTML = text; else el.textContent = text;
}

function pick(f) {
  if (!f) return;
  if (!/\.(html?|zip)$/i.test(f.name)) { msg('Нужен файл .html, .htm или .zip', 'err'); return; }
  file = f;
  $('#drop-text').innerHTML = '';
  const b = document.createElement('b'); b.textContent = f.name;
  const s = document.createElement('small'); s.textContent = ` · ${fmtSize(f.size)} — нажмите, чтобы выбрать другой`;
  $('#drop-text').append(b, s);
  $('#submit').disabled = false;
  msg('');
}

$('#file').addEventListener('change', (e) => pick(e.target.files[0]));
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => pick(e.dataTransfer.files[0]));

$('#form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!file) return;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/sites');
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
  xhr.setRequestHeader('X-Title', encodeURIComponent($('#title').value));
  xhr.setRequestHeader('X-Description', encodeURIComponent($('#desc').value));
  const bar = $('#progress'); bar.hidden = false; bar.firstElementChild.style.width = '0';
  xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) bar.firstElementChild.style.width = `${(ev.loaded / ev.total) * 100}%`; };
  $('#submit').disabled = true;
  msg('Загрузка…');
  xhr.onload = () => {
    bar.hidden = true;
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status === 201) {
      saveKey(data.id, data.deleteKey);
      sites.unshift(data);
      render();
      const url = siteUrl(data.id);
      msg(`Сохранено! Постоянная ссылка: <a href="${url}" target="_blank" rel="noopener">${url}</a>`, 'ok', true);
      $('#form').reset(); file = null;
      $('#drop-text').innerHTML = '<b>Перетащите файл сюда</b> или нажмите, чтобы выбрать<br><small>.html, .htm или .zip (сайт с картинками и стилями)</small>';
    } else {
      $('#submit').disabled = false;
      msg(data.error || `Ошибка загрузки (${xhr.status})`, 'err');
    }
  };
  xhr.onerror = () => { bar.hidden = true; $('#submit').disabled = false; msg('Не удалось связаться с сервером', 'err'); };
  xhr.send(file);
});

function render() {
  const q = $('#search').value.trim().toLowerCase();
  const keys = loadKeys();
  const list = $('#list');
  const shown = sites.filter((s) => !q || `${s.title} ${s.description} ${s.originalName}`.toLowerCase().includes(q));
  $('#count').textContent = sites.length ? `· ${sites.length}` : '';
  $('#empty').hidden = sites.length > 0;
  $('#empty').textContent = 'Пока здесь пусто — загрузите первый сайт.';
  if (sites.length && !shown.length) { $('#empty').hidden = false; $('#empty').textContent = 'Ничего не найдено.'; }
  list.replaceChildren(...shown.map((s) => {
    const el = $('#tpl').content.firstElementChild.cloneNode(true);
    const url = `/s/${s.id}/`;
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
      try { await navigator.clipboard.writeText(siteUrl(s.id)); copy.textContent = 'Скопировано ✓'; }
      catch { prompt('Ссылка на сайт:', siteUrl(s.id)); }
      setTimeout(() => (copy.textContent = 'Ссылка'), 1500);
    };
    const del = el.querySelector('.del');
    if (keys[s.id]) {
      del.hidden = false;
      del.onclick = async () => {
        if (!confirm(`Удалить «${s.title}» из архива? Это нельзя отменить.`)) return;
        const r = await fetch(`/api/sites/${s.id}`, { method: 'DELETE', headers: { 'X-Delete-Key': keys[s.id] } });
        if (r.status === 204 || r.status === 404) { dropKey(s.id); sites = sites.filter((x) => x.id !== s.id); render(); }
        else alert('Не удалось удалить сайт');
      };
    }
    return el;
  }));
}

$('#search').addEventListener('input', render);

fetch('/api/sites').then((r) => r.json()).then((d) => { sites = d; render(); })
  .catch(() => msg('Не удалось загрузить список сайтов', 'err'));
