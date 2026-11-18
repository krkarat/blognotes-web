// Управление записью: создание заметки, остановка, отмена, восстановление после блокировки и вылета.
import * as S from './store.js';
import * as idb from './idb.js';
import { Recorder, assemble } from './audio.js';
import { kick } from './transcriber.js';
import { keepAwake, release } from './wake.js';
import { log } from './log.js';

const recorder = new Recorder();
let cur = null; // {ideaId, itemId, newIdea, started}
const subs = new Set();
let level = 0;
export const subscribe = fn => { subs.add(fn); return () => subs.delete(fn); };
const emit = () => subs.forEach(f => f(cur));
export const current = () => cur;
export const getLevel = () => level;
export const elapsed = () => recorder.elapsed;

let afterHook = () => {};
/** Что делать после остановки новой мысли (показать выбор рубрики) */
export const onAfter = fn => { afterHook = fn; };

/** Вызывать прямо из обработчика касания */
export async function start(ideaId, rubricId) {
  if (cur) return;
  const item = S.newItem('VOICE', { tx: 'RECORDING' });
  item.file = item.id + '.wav';
  let newIdea = false;
  if (!ideaId) {
    const i = S.newIdea(rubricId || null, [item]);
    ideaId = i.id; newIdea = true;
    S.addIdea(i);
  } else S.addItem(ideaId, item);
  cur = { ideaId, itemId: item.id, newIdea, started: Date.now() };
  emit();
  try {
    await recorder.start(item.id, l => { level = l; });
    keepAwake('rec');
    log('запись началась');
  } catch (e) {
    log('микрофон: ' + e.name + ' ' + e.message);
    dropItem(cur);
    cur = null; emit();
    throw e;
  }
}

function dropItem(c) {
  S.removeItem(c.ideaId, c.itemId);
  const i = S.idea(c.ideaId);
  if (c.newIdea && i && !i.items.length && !i.title) S.deleteIdea(c.ideaId);
}

/** Остановить и сохранить. reason для журнала: stop | hidden */
export async function stop(reason = 'stop') {
  const c = cur;
  if (!c) return;
  cur = null; emit();
  await recorder.stop();
  release('rec');
  log('запись остановлена: ' + reason);
  const ok = await finalize(c.ideaId, c.itemId);
  if (ok && c.newIdea) afterHook(c.ideaId, reason);
  else if (!ok) afterHook(null, 'short');
}

export async function cancel() {
  const c = cur;
  if (!c) return;
  cur = null; emit();
  await recorder.stop();
  release('rec');
  await idb.dropChunks(c.itemId);
  dropItem(c);
}

/** Склеить сохранённые куски в файл. false, если звука почти нет */
async function finalize(ideaId, itemId) {
  const a = await assemble(itemId);
  if (!a) {
    await idb.dropChunks(itemId);
    const i = S.idea(ideaId);
    const newOnly = i && !i.title && i.items.length === 1;
    if (newOnly) S.deleteIdea(ideaId); else S.removeItem(ideaId, itemId);
    return false;
  }
  await S.putFile(itemId + '.wav', a.blob);
  S.updateItem(ideaId, itemId, x => ({ ...x, tx: 'PENDING', durationMs: a.ms, file: itemId + '.wav' }));
  await S.flush();
  await idb.dropChunks(itemId);
  kick();
  return true;
}

/** После перезапуска: записи, которые прервались, собираем из сохранённых кусков */
export async function recover() {
  const d = S.get();
  let n = 0;
  for (const i of d.ideas) for (const t of i.items) {
    if (t.type === 'VOICE' && t.tx === 'RECORDING') { await finalize(i.id, t.id); n++; }
  }
  // куски без заметки (заметку успели удалить) не храним
  const known = new Set(S.get().ideas.flatMap(i => i.items.map(t => t.id)));
  for (const r of await idb.chunkRecs()) if (!known.has(r)) await idb.dropChunks(r);
  if (n) log('восстановлено прерванных записей: ' + n);
  return n;
}

// экран заблокировали или переключились на другое приложение: сохраняем, что успели сказать
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && cur) stop('hidden'); });
window.addEventListener('pagehide', () => { if (cur) stop('hidden'); });
