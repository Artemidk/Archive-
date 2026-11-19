'use strict';
// Распаковка ZIP в браузере без библиотек (stored + deflate через DecompressionStream).
window.unzipFile = async function unzipFile(buffer) {
  const buf = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Это не ZIP-архив или он повреждён');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder('utf-8');
  const cp866 = (() => { try { return new TextDecoder('ibm866'); } catch { return utf8; } })();
  const files = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP повреждён');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    // имена без флага UTF-8 из Windows-архиваторов обычно в CP866
    const name = (flags & 0x800) ? utf8.decode(nameBytes) : (() => {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); } catch { return cp866.decode(nameBytes); }
    })();
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('Архивы с паролем не поддерживаются');
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const comp = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = comp;
    else if (method === 8) data = new Uint8Array(await new Response(new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else throw new Error(`Метод сжатия ${method} не поддерживается`);
    if (data.length !== size) throw new Error('ZIP повреждён: неверный размер файла');
    files.push({ name, data });
  }
  return files;
};
