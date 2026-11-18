// Хранилище в телефоне: IndexedDB. Всё живёт только на этом устройстве.
// kv: данные приложения (JSON), files: голосовые и картинки, chunks: куски идущей записи,
// model: модель распознавания кусками по 4 МБ.
const NAME = 'blognotes';
let dbp = null;

export function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('kv');
      d.createObjectStore('files');
      const c = d.createObjectStore('chunks', { autoIncrement: true });
      c.createIndex('rec', 'rec');
      d.createObjectStore('model');
    };
    r.onsuccess = () => {
      const d = r.result;
      d.onversionchange = () => d.close();
      res(d);
    };
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('База занята другой вкладкой'));
  });
  return dbp;
}

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function done(tx) { return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('abort')); }); }

// Blob храним как ArrayBuffer: Safari (особенно в приватном режиме) не всегда умеет класть Blob в IndexedDB.
// Старые записи, сохранённые как Blob, читаются как раньше.
const BOX = '__blob';
const unbox = v => (v && v[BOX] instanceof ArrayBuffer ? new Blob([v[BOX]], { type: v.type || '' }) : v);

export async function get(store, key) {
  const d = await open();
  return unbox(await req(d.transaction(store).objectStore(store).get(key)));
}
export async function put(store, key, value) {
  if (value instanceof Blob) value = { [BOX]: await value.arrayBuffer(), type: value.type }; // до открытия транзакции
  const d = await open();
  const tx = d.transaction(store, 'readwrite');
  if (key === undefined) tx.objectStore(store).put(value); else tx.objectStore(store).put(value, key);
  return done(tx);
}
export async function del(store, key) {
  const d = await open();
  const tx = d.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}
export async function keys(store) {
  const d = await open();
  return req(d.transaction(store).objectStore(store).getAllKeys());
}
export async function clear(store) {
  const d = await open();
  const tx = d.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  return done(tx);
}

// ---- куски записи ----
export async function addChunk(rec, seq, pcm) {
  const d = await open();
  const tx = d.transaction('chunks', 'readwrite');
  tx.objectStore('chunks').add({ rec, seq, pcm });
  return done(tx);
}
/** Все куски записи по порядку */
export async function chunksOf(rec) {
  const d = await open();
  const all = await req(d.transaction('chunks').objectStore('chunks').index('rec').getAll(rec));
  return all.sort((a, b) => a.seq - b.seq).map(c => c.pcm);
}
export async function dropChunks(rec) {
  const d = await open();
  const tx = d.transaction('chunks', 'readwrite');
  const idx = tx.objectStore('chunks').index('rec');
  const ks = await req(idx.getAllKeys(rec));
  ks.forEach(k => tx.objectStore('chunks').delete(k));
  return done(tx);
}
export async function chunkRecs() {
  const d = await open();
  const recs = await req(d.transaction('chunks').objectStore('chunks').getAll());
  return [...new Set(recs.map(r => r.rec))];
}
