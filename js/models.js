// Модель распознавания: скачивается один раз кусками по 4 МБ в память телефона,
// докачивается после обрыва и проверяется целиком до первого запуска.
import * as idb from './idb.js';

export const MODELS = [
  { key: 'base', title: 'Быстрая', note: 'Подходит для большинства телефонов. Расшифровывает быстро, иногда ошибается в словах.', file: 'ggml-base-q5_1.bin', size: 59707625, mb: 60 },
  { key: 'small', title: 'Точная', note: 'Лучше понимает русский и знаки препинания, но в 3 раза медленнее и требует много памяти. На старых iPhone может не запуститься.', file: 'ggml-small-q5_1.bin', size: 190085487, mb: 190 },
];
const MIRRORS = [
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/',
  'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/',
];
const PART = 4 * 1024 * 1024;

export const info = key => MODELS.find(m => m.key === key);

// состояние для интерфейса
let state = { loading: null, done: 0, total: 0, error: null };
const subs = new Set();
export const subscribe = fn => { subs.add(fn); return () => subs.delete(fn); };
export const getState = () => state;
const setState = s => { state = { ...state, ...s }; subs.forEach(f => f(state)); };

const metaKey = key => 'model:' + key;
export async function meta(key) { return (await idb.get('kv', metaKey(key))) || { parts: 0, bytes: 0, ok: false }; }
export async function installed(key) { return !!(await meta(key)).ok; }

/** Части модели как Blob-ы по порядку */
export async function parts(key) {
  const m = await meta(key);
  const out = [];
  for (let i = 0; i < m.parts; i++) {
    const b = await idb.get('model', key + ':' + i);
    if (!b) throw new Error('часть ' + i + ' потеряна');
    out.push(b);
  }
  return out;
}

export async function remove(key) {
  const m = await meta(key);
  for (let i = 0; i < m.parts + 1; i++) await idb.del('model', key + ':' + i);
  await idb.del('kv', metaKey(key));
}

let busy = false;
/** Скачать модель (или докачать). Можно вызывать повторно: второй вызов ничего не делает */
export async function download(key) {
  if (busy) return;
  busy = true;
  const mi = info(key);
  try {
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    let m = await meta(key);
    if (m.ok) return;
    setState({ loading: key, done: m.bytes, total: mi.size, error: null });
    let lastErr = null, localErr = null;
    // сначала со своего сайта (тот же адрес, что и приложение: без блокировок и чужих серверов)
    const local = await fetch('models/' + mi.file + '.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (local && local.size === mi.size) {
      for (let attempt = 0; attempt < 6 && m.bytes < mi.size; attempt++) {
        try { m = await fetchParts(key, mi, m, local.parts); } catch (e) { lastErr = localErr = e; console.warn('model local', String(e && e.name), String(e && e.message || e)); await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); }
      }
    }
    for (let attempt = 0; attempt < 6 && m.bytes < mi.size; attempt++) {
      for (const base of MIRRORS) {
        try {
          m = await fetchFrom(base + mi.file, key, mi, m);
          if (m.bytes >= mi.size) break;
        } catch (e) { lastErr = e; console.warn('model', base, String(e && e.message || e)); }
      }
      if (m.bytes < mi.size) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
    if (m.bytes !== mi.size) {
      if (m.bytes > mi.size) await remove(key);
      throw localErr || lastErr || new Error('скачалось ' + m.bytes + ' байт из ' + mi.size);
    }
    const bad = await validate(new Blob(await parts(key)));
    if (bad) { await remove(key); throw new Error('файл модели повреждён (' + bad + '), скачаю заново при следующей попытке'); }
    m = { ...m, ok: true };
    await idb.put('kv', metaKey(key), m);
    setState({ loading: null, done: mi.size, total: mi.size });
  } catch (e) {
    setState({ loading: null, error: String(e.message || e) });
    throw e;
  } finally { busy = false; }
}

/** Модель лежит на сайте кусками ровно по 4 МБ: кусок N сайта = кусок N в телефоне */
async function fetchParts(key, mi, m, total) {
  for (let k = m.parts; k < total; k++) {
    if (m.bytes !== k * PART) throw new Error('куски не сходятся');
    const r = await fetch('models/' + mi.file + '.' + String(k).padStart(3, '0'), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const want = Math.min(PART, mi.size - k * PART);
    if (blob.size !== want) throw new Error('кусок ' + k + ' не того размера');
    await idb.put('model', key + ':' + k, blob);
    m = { ...m, parts: k + 1, bytes: m.bytes + blob.size };
    await idb.put('kv', metaKey(key), m);
    setState({ done: m.bytes });
  }
  return m;
}

async function fetchFrom(url, key, mi, m) {
  const headers = m.bytes > 0 ? { Range: 'bytes=' + m.bytes + '-' } : {};
  const r = await fetch(url, { headers, cache: 'no-store' });
  if (m.bytes > 0 && r.status === 200) {
    // сервер не умеет докачку: начинаем заново, иначе файл склеится неправильно
    await remove(key); m = { parts: 0, bytes: 0, ok: false };
  } else if (m.bytes > 0) {
    const cr = r.headers.get('Content-Range') || '';
    if (r.status !== 206 || (cr && !cr.startsWith('bytes ' + m.bytes + '-'))) throw new Error('докачка не с того места');
  } else if (!r.ok) throw new Error('HTTP ' + r.status);
  const reader = r.body.getReader();
  let buf = [], len = 0;
  const flush = async () => {
    if (!len) return;
    const blob = new Blob(buf);
    buf = []; len = 0;
    await idb.put('model', key + ':' + m.parts, blob);
    m = { ...m, parts: m.parts + 1, bytes: m.bytes + blob.size };
    await idb.put('kv', metaKey(key), m);
  };
  // куски строго по 4 МБ (последний меньше), чтобы после обрыва докачивать ровно с границы
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let v = value;
    while (v.length) {
      const take = Math.min(v.length, PART - len);
      buf.push(v.subarray(0, take)); len += take; v = v.subarray(take);
      if (len === PART) await flush();
      setState({ done: m.bytes + len });
    }
  }
  await flush();
  return m;
}

// ---- проверка файла (как ModelCheck.java в Android-версии) ----
const TYPE_BYTES = { 0: n => n * 4, 1: n => n * 2, 2: n => n / 32 * 18, 3: n => n / 32 * 20, 6: n => n / 32 * 22, 7: n => n / 32 * 24, 8: n => n / 32 * 34 };

/** null = в порядке, иначе описание ошибки */
export async function validate(blob) {
  const size = blob.size;
  const headLen = Math.min(size, 3 * 1024 * 1024);
  const head = new DataView(await blob.slice(0, headLen).arrayBuffer());
  let pos = 0;
  const i32 = () => { if (pos + 4 > headLen) throw new Error('файл обрезан'); const v = head.getInt32(pos, true); pos += 4; return v; };
  try {
    if ((i32() >>> 0) !== 0x67676d6c) return 'не модель whisper';
    for (let i = 0; i < 11; i++) i32();
    const nMel = i32(), nFft = i32();
    if (nMel <= 0 || nMel > 512 || nFft <= 0 || nFft > 4096) return 'заголовок повреждён';
    pos += nMel * nFft * 4;
    const nVocab = i32();
    if (nVocab <= 0 || nVocab > 200000) return 'словарь повреждён';
    for (let i = 0; i < nVocab; i++) { const l = i32() >>> 0; if (l > 1024) return 'словарь повреждён'; pos += l; }
    let tensors = 0;
    while (pos < size) {
      const h = new DataView(await blob.slice(pos, pos + 12 + 16).arrayBuffer());
      if (h.byteLength < 12) return 'файл обрезан';
      const nDims = h.getInt32(0, true), nameLen = h.getInt32(4, true), type = h.getInt32(8, true);
      if (nDims < 1 || nDims > 4 || nameLen <= 0 || nameLen > 1024) return 'тензор ' + tensors + ' повреждён';
      if (h.byteLength < 12 + nDims * 4) return 'файл обрезан';
      let n = 1;
      for (let i = 0; i < nDims; i++) { const ne = h.getInt32(12 + i * 4, true); if (ne <= 0) return 'тензор ' + tensors + ' повреждён'; n *= ne; }
      const tb = TYPE_BYTES[type];
      if (!tb) return 'неизвестный тип тензора ' + type;
      pos += 12 + nDims * 4 + nameLen + tb(n);
      tensors++;
    }
    if (pos !== size) return 'файл обрезан';
    if (tensors < 10) return 'слишком мало тензоров';
    return null;
  } catch (e) { return e.message; }
}
