// Данные приложения. Формат JSON совпадает с Android-версией, поэтому резервные копии
// переносятся между телефонами в обе стороны.
import * as idb from './idb.js';
import { DEFAULT_AI_TEMPLATE, DEFAULT_AI_TEMPLATE_IDEA, RUBRIC_COLORS, headline } from './texts.js';
import { plain } from './format.js';

// Два статуса, как в Android. Старые (Сырая/Снято/Опубликовано) сводятся к ним
export const STATUSES = [['WORK', 'В работе'], ['DONE', 'Закрыто']];
export const statusOf = s => (s === 'DONE' || s === 'SHOT' || s === 'PUBLISHED') ? 'DONE' : 'WORK';
export const statusLabel = s => (STATUSES.find(x => x[0] === statusOf(s)) || STATUSES[0])[1];

export function newId() {
  const a = crypto.getRandomValues(new Uint8Array(6));
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

const defSettings = () => ({
  onboarded: false, model: '', language: 'ru', aiTemplate: DEFAULT_AI_TEMPLATE, aiTemplateIdea: DEFAULT_AI_TEMPLATE_IDEA, phrases: true,
  theme: 'system', recordOnOpen: false, widget: 'mic', name: '', glow: 'auto',
});

let db = { version: 1, rubrics: [], ideas: [], settings: defSettings() };
const subs = new Set();
let writing = Promise.resolve();

export const get = () => db;
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

export function decode(text) {
  const o = JSON.parse(text);
  const s = { ...defSettings(), ...(o.settings || {}) };
  return {
    version: 1,
    rubrics: (o.rubrics || []).map(r => ({ id: String(r.id), name: r.name || '', color: toInt(r.color), deletedAt: r.deletedAt || 0 })),
    ideas: (o.ideas || []).map(i => ({
      id: String(i.id), title: i.title || '', rubricId: i.rubricId ?? null, status: statusOf(i.status),
      created: i.created || Date.now(), updated: i.updated || i.created || Date.now(), deletedAt: i.deletedAt || 0,
      items: (i.items || []).map(t => ({
        id: String(t.id), type: t.type || 'TEXT', text: t.text || '', file: t.file || '', url: t.url || '',
        durationMs: t.durationMs || 0, tx: t.tx || 'NONE', created: t.created || Date.now(), done: !!t.done,
      })),
    })),
    settings: s,
  };
}
export const encode = d => JSON.stringify(d, null, 1);

// Цвет в Android хранится как знаковый int ARGB, в вебе удобнее #RRGGBB
const toInt = c => typeof c === 'number' ? c : (parseInt(String(c).replace('#', ''), 16) | 0xFF000000) | 0;
export const cssColor = c => '#' + ((c >>> 0) & 0xFFFFFF).toString(16).padStart(6, '0');

export async function load() {
  const t = await idb.get('kv', 'notes.json');
  if (t) { try { db = decode(t); } catch (e) { console.error(e); } }
  return db;
}

function set(next) {
  db = next;
  const text = encode(next);
  // пишем последовательно, чтобы старое состояние не перезаписало новое
  writing = writing.then(() => idb.put('kv', 'notes.json', text)).catch(e => console.error('save', e));
  subs.forEach(f => f(db));
  return db;
}
export const update = fn => set(fn(db));
export const flush = () => writing;

// ---- идеи ----
// d.rubrics хранит все рубрики, вместе с убранными в архив (deletedAt), как в Android
const archivedRubric = (d, id) => !!id && d.rubrics.some(r => r.id === id && r.deletedAt);
/** Рабочие рубрики по порядку */
export const rubrics = d => d.rubrics.filter(r => !r.deletedAt);
export const archivedRubrics = d => d.rubrics.filter(r => r.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
/** Рабочие идеи: без удалённых, закрытых и идей архивных рубрик */
export const active = d => d.ideas.filter(i => !i.deletedAt && i.status !== 'DONE' && !archivedRubric(d, i.rubricId));
export const closed = d => d.ideas.filter(i => !i.deletedAt && i.status === 'DONE' && !archivedRubric(d, i.rubricId)).sort((a, b) => b.updated - a.updated);
export const trash = d => d.ideas.filter(i => i.deletedAt && !archivedRubric(d, i.rubricId)).sort((a, b) => b.deletedAt - a.deletedAt);
export const countIn = (d, rid) => d.ideas.filter(i => i.rubricId === rid && !i.deletedAt).length;
export const idea = (id, d = db) => d.ideas.find(i => i.id === id);
export const rubric = (id, d = db) => d.rubrics.find(r => r.id === id);

export function displayTitle(i) {
  if (i.title.trim()) return i.title.trim();
  const first = i.items.find(t => t.text.trim());
  if (first) return headline(plain(first.text.trim()).replace(/\n/g, ' '));
  const v = i.items.filter(t => t.type === 'VOICE');
  if (v.some(t => t.tx === 'RECORDING')) return 'Идёт запись…';
  if (v.some(t => t.tx === 'PENDING' || t.tx === 'RUNNING')) return 'Расшифровываю…';
  if (v.length) return 'Голосовая заметка';
  const l = i.items.find(t => t.type === 'LINK');
  if (l) return l.url;
  if (i.items.some(t => t.type === 'IMAGE')) return 'Референс';
  return 'Без названия';
}
export const allText = i => i.items.map(t => t.type === 'LINK' ? t.url + ' ' + t.text : t.text).join('\n');

export function newIdea(rubricId = null, items = []) {
  const now = Date.now();
  return { id: newId(), title: '', rubricId, status: 'WORK', items, created: now, updated: now, deletedAt: 0 };
}
export function newItem(type, extra = {}) {
  return { id: newId(), type, text: '', file: '', url: '', durationMs: 0, tx: 'NONE', created: Date.now(), done: false, ...extra };
}

export const addIdea = i => update(d => ({ ...d, ideas: [i, ...d.ideas] }));
export const updateIdea = (id, fn) => update(d => ({ ...d, ideas: d.ideas.map(i => i.id === id ? { ...fn(i), updated: Date.now() } : i) }));
export const updateItem = (ideaId, itemId, fn, touch = true) => update(d => ({
  ...d, ideas: d.ideas.map(i => i.id !== ideaId ? i : {
    ...i, items: i.items.map(t => t.id === itemId ? fn(t) : t), updated: touch ? Date.now() : i.updated,
  }),
}));
export const addItem = (ideaId, item) => updateIdea(ideaId, i => ({ ...i, items: [...i.items, item] }));

export function removeItem(ideaId, itemId) {
  const t = idea(ideaId)?.items.find(x => x.id === itemId);
  updateIdea(ideaId, i => ({ ...i, items: i.items.filter(x => x.id !== itemId) }));
  if (t?.file) idb.del('files', t.file);
}
export const trashIdea = id => update(d => ({ ...d, ideas: d.ideas.map(i => i.id === id ? { ...i, deletedAt: Date.now() } : i) }));
/** Вернуть из архива; если рубрика идеи в архиве, идея идёт во «Входящие» */
export const restoreIdea = id => update(d => ({ ...d, ideas: d.ideas.map(i => i.id !== id ? i
  : { ...i, deletedAt: 0, status: 'WORK', rubricId: archivedRubric(d, i.rubricId) ? null : i.rubricId, updated: Date.now() }) }));
/** Записи одной идеи переносятся в конец другой, первая идея исчезает */
export function mergeInto(srcId, dstId) {
  const src = idea(srcId); if (!src || srcId === dstId) return;
  update(d => ({ ...d, ideas: d.ideas.filter(i => i.id !== srcId).map(i => i.id !== dstId ? i
    : { ...i, items: [...i.items, ...src.items], title: i.title || src.title, updated: Date.now() }) }));
}
export function deleteIdea(id) {
  const i = idea(id);
  if (!i) return;
  update(d => ({ ...d, ideas: d.ideas.filter(x => x.id !== id) }));
  i.items.forEach(t => t.file && idb.del('files', t.file));
}
/** Очистить архив: закрытые, удалённые и архивные рубрики с их идеями */
export function emptyTrash() {
  closed(db).forEach(i => deleteIdea(i.id));
  trash(db).forEach(i => deleteIdea(i.id));
  archivedRubrics(db).forEach(r => eraseRubric(r.id));
}

// ---- рубрики ----
export function addRubric(name) {
  const used = new Set(rubrics(db).map(r => cssColor(r.color).toUpperCase()));
  const c = RUBRIC_COLORS.find(x => !used.has(x.toUpperCase())) || RUBRIC_COLORS[rubrics(db).length % RUBRIC_COLORS.length];
  const r = { id: newId(), name: name.trim(), color: toInt(c), deletedAt: 0 };
  update(d => ({ ...d, rubrics: [...d.rubrics, r] }));
  return r;
}
export const renameRubric = (id, name) => update(d => ({ ...d, rubrics: d.rubrics.map(r => r.id === id ? { ...r, name: name.trim() } : r) }));
export function moveRubric(id, delta) {
  const l = rubrics(db).map(r => r.id); const i = l.indexOf(id); const j = i + delta;
  if (i < 0 || j < 0 || j >= l.length) return;
  l.splice(j, 0, l.splice(i, 1)[0]); reorderRubrics(l);
}
/** Новый порядок рабочих рубрик; архивные остаются в конце */
export const reorderRubrics = ids => update(d => {
  const by = Object.fromEntries(d.rubrics.map(r => [r.id, r]));
  const head = ids.map(id => by[id]).filter(Boolean);
  return { ...d, rubrics: [...head, ...d.rubrics.filter(r => !ids.includes(r.id))] };
});
/** Рубрика уходит в архив вместе со своими идеями, её можно вернуть */
export const archiveRubric = id => update(d => ({ ...d, rubrics: d.rubrics.map(r => r.id === id ? { ...r, deletedAt: Date.now() } : r) }));
export const restoreRubric = id => update(d => ({ ...d, rubrics: d.rubrics.map(r => r.id === id ? { ...r, deletedAt: 0 } : r) }));
export function eraseRubric(id) {
  db.ideas.filter(i => i.rubricId === id).forEach(i => deleteIdea(i.id));
  update(d => ({ ...d, rubrics: d.rubrics.filter(r => r.id !== id) }));
}
export const deleteRubric = archiveRubric;

export const settings = fn => update(d => ({ ...d, settings: fn(d.settings) }));
export const replaceAll = next => set(next);

// ---- файлы ----
export const putFile = (name, blob) => idb.put('files', name, blob);
export const getFile = name => idb.get('files', name);
