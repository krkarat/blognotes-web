// Очередь расшифровки: голосовые по одному, в отдельном потоке.
import * as S from './store.js';
import * as M from './models.js';
import { wavToFloat } from './audio.js';
import { cleanTranscript } from './texts.js';
import { log } from './log.js';
import { keepAwake, release } from './wake.js';

let worker = null, workerKey = null, running = false, idleTimer = null;
let status = { blocked: null, progress: 0, current: null };
const subs = new Set();
export const subscribe = fn => { subs.add(fn); return () => subs.delete(fn); };
export const getStatus = () => status;
const setStatus = s => { status = { ...status, ...s }; subs.forEach(f => f(status)); };

function call(msg, transfer) {
  return new Promise((res, rej) => {
    const w = worker;
    w.onmessage = e => {
      const d = e.data;
      if (d.type === 'progress') setStatus({ progress: d.p });
      else if (d.type === 'log') log('whisper: ' + d.text.trim());
      else if (d.type === 'error') rej(new Error(d.error));
      else res(d);
    };
    w.onerror = e => rej(new Error(e.message || 'сбой потока распознавания'));
    w.postMessage(msg, transfer || []);
  });
}

function killWorker() { if (worker) { worker.terminate(); worker = null; workerKey = null; } }

/** Сколько раз пробовали каждую запись: защита от бесконечных повторов после вылета */
const tries = id => +(localStorage.getItem('tries_' + id) || 0);
const setTries = (id, n) => { try { n ? localStorage.setItem('tries_' + id, n) : localStorage.removeItem('tries_' + id); } catch {} };

/** После перезапуска: прерванные расшифровки снова в очередь (не больше 2 попыток) */
export function recover() {
  const d = S.get();
  for (const i of d.ideas) for (const t of i.items) {
    if (t.type === 'VOICE' && t.tx === 'RUNNING') {
      if (tries(t.id) >= 2) { S.updateItem(i.id, t.id, x => ({ ...x, tx: 'ERROR' }), false); log('расшифровка ' + t.id + ' прерывалась дважды'); }
      else S.updateItem(i.id, t.id, x => ({ ...x, tx: 'PENDING' }), false);
    }
  }
}

export function retry(ideaId, itemId) {
  setTries(itemId, 0);
  S.updateItem(ideaId, itemId, x => ({ ...x, tx: 'PENDING', text: '' }), false);
  kick();
}

function nextPending() {
  // старые сначала
  const list = [];
  for (const i of S.get().ideas) for (const t of i.items) if (t.type === 'VOICE' && t.tx === 'PENDING') list.push([i, t]);
  list.sort((a, b) => a[1].created - b[1].created);
  return list[0];
}

export async function kick() {
  if (running) return;
  running = true;
  clearTimeout(idleTimer);
  try {
    for (;;) {
      const next = nextPending();
      if (!next) break;
      const key = S.get().settings.model || 'base';
      if (!(await M.installed(key))) {
        setStatus({ blocked: M.getState().loading ? 'Модель распознавания ещё скачивается' : 'Модель распознавания не скачана' });
        break;
      }
      setStatus({ blocked: null });
      await runOne(next[0], next[1], key);
    }
  } finally {
    running = false;
    setStatus({ current: null, progress: 0 });
    release('tx');
    // модель держит память: выгружаем, если минуту нечего делать
    idleTimer = setTimeout(killWorker, 60000);
  }
}

async function runOne(idea, item, key) {
  setTries(item.id, tries(item.id) + 1);
  S.updateItem(idea.id, item.id, x => ({ ...x, tx: 'RUNNING' }), false);
  setStatus({ current: item.id, progress: 0 });
  keepAwake('tx');
  try {
    const blob = await S.getFile(item.file);
    if (!blob) throw new Error('аудиофайл не найден');
    const pcm = await wavToFloat(blob);
    if (!worker || workerKey !== key) {
      killWorker();
      worker = new Worker('js/worker.js');
      const parts = await M.parts(key);
      const r = await call({ cmd: 'init', key, parts });
      workerKey = key;
      log('модель ' + key + ' загружена за ' + r.ms + ' мс');
    }
    const audioMs = Math.round(pcm.length / 16);
    const r = await call({ cmd: 'run', pcm, lang: S.get().settings.language || 'ru' }, [pcm.buffer]);
    log('расшифровка ' + audioMs + ' мс звука за ' + r.ms + ' мс');
    const text = cleanTranscript(r.text);
    S.updateItem(idea.id, item.id, x => ({ ...x, tx: 'DONE', text }));
    setTries(item.id, 0);
  } catch (e) {
    log('ошибка расшифровки: ' + e.message);
    killWorker();
    S.updateItem(idea.id, item.id, x => ({ ...x, tx: 'ERROR' }), false);
  }
}

/** Для проверки в CI: расшифровать готовый Float32 в отдельном потоке, не мешая очереди */
export async function transcribeRaw(pcm, key = 'base', lang = 'ru') {
  const w = new Worker('js/worker.js');
  const once = msg => new Promise((res, rej) => {
    w.onmessage = e => { const d = e.data; if (d.type === 'error') rej(new Error(d.error)); else if (d.type !== 'progress' && d.type !== 'log') res(d); else if (d.type === 'log') log('whisper: ' + d.text.trim()); };
    w.postMessage(msg, msg.pcm ? [msg.pcm.buffer] : []);
  });
  try {
    await once({ cmd: 'init', key, parts: await M.parts(key) });
    return await once({ cmd: 'run', pcm, lang });
  } finally { w.terminate(); }
}
