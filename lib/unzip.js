'use strict';
// Минимальный распаковщик ZIP без зависимостей (stored + deflate).
const zlib = require('zlib');

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('Некорректный ZIP: не найден конец архива');
}

function unzip(buf, { maxTotal = 200 * 1024 * 1024, maxFiles = 5000 } = {}) {
  const eocd = findEOCD(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > maxFiles) throw new Error('Слишком много файлов в архиве');
  const files = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Некорректный ZIP: повреждён каталог');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const rawName = buf.slice(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800) ? rawName.toString('utf8') : rawName.toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // каталог
    if (flags & 0x1) throw new Error('Зашифрованные ZIP не поддерживаются');
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('Некорректный ZIP: повреждён заголовок файла');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(start, start + compSize);
    let data;
    if (method === 0) data = comp;
    else if (method === 8) data = zlib.inflateRawSync(comp, { maxOutputLength: Math.max(1, maxTotal - total) });
    else throw new Error(`Метод сжатия ${method} не поддерживается`);
    if (data.length !== size) throw new Error('Некорректный ZIP: неверный размер файла');
    total += data.length;
    if (total > maxTotal) throw new Error('Распакованный архив слишком большой');
    files.push({ name, data });
  }
  return files;
}

module.exports = { unzip };
