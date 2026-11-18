import { html, render, useState, useEffect, useRef } from './vendor/preact-htm.js';
import * as S from './store.js';
import * as M from './models.js';
import * as T from './transcriber.js';
import * as R from './rec.js';
import * as A from './audio.js';
import * as idb from './idb.js';
import { Icon } from './icons.js';
import { typo, nextPhrase, formatDate, formatDuration, plural, splitLinks, domain, findUrls, normalizeUrl } from './texts.js';
import { log, readLog } from './log.js';
import { makeZip, readZip } from './zip.js';

export const VERSION = '1.0.0';
const ALL = '*', INBOX = '-';

// ---------- общее ----------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const titleOf = d => d.settings.name.trim() ? 'Заметки ' + d.settings.name.trim() : 'Заметки блогера';
const cssColor = S.cssColor;
const statusColor = s => ({ RAW: 'var(--muted)', WORK: 'var(--warm)', SHOT: 'var(--st-shot)', PUBLISHED: 'var(--st-pub)' }[s] || 'var(--muted)');
const inRubric = (d, i, r) => r === ALL ? true : r === INBOX ? (!i.rubricId || !S.rubric(i.rubricId, d)) : i.rubricId === r;

let toastSet = () => {};
export const toast = t => toastSet(t);

function nav(path) { location.hash = path; }
function back() { if (history.length > 1 && location.hash !== '#/') history.back(); else nav('/'); }

function useStore(sub, get) {
  const [v, setV] = useState(get());
  useEffect(() => sub(setV), []);
  return v;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

const Dot = ({ c, s = 10 }) => html`<span class="dot" style=${{ background: c, width: s + 'px', height: s + 'px' }}></span>`;
const Pill = ({ s, filled, onClick }) => html`<button class="pill" onClick=${onClick}
  style=${{ background: filled ? statusColor(s) : `color-mix(in srgb, ${statusColor(s)} 16%, transparent)`, color: filled ? '#1B1830' : statusColor(s) }}>${S.statusLabel(s)}</button>`;
const Phrase = ({ text, big }) => html`<div class=${'phrase' + (big ? ' big' : '')}>${text}</div>`;
const Banner = ({ text, alert, onClick }) => html`<button class=${'banner' + (alert ? ' alert' : '')} onClick=${onClick}>
  ${alert && html`<${Icon} n="alert" />`}<span>${text}</span></button>`;

function LinkText({ text, cls = 'txt' }) {
  return html`<div class=${cls}>${splitLinks(text).map(p => p.url
    ? html`<a href=${p.url} target="_blank" rel="noopener" onClick=${e => e.stopPropagation()}>${p.t}</a>` : p.t)}</div>`;
}

/** Фраза держится не меньше 4 с + 60 мс на букву, даже если расшифровка закончилась быстрее */
const shown = new Map();
function LingerPhrase({ k, active }) {
  const on = S.get().settings.phrases;
  const [, force] = useState(0);
  if (on && active && !shown.has(k)) shown.set(k, { text: nextPhrase(), at: Date.now() });
  const p = shown.get(k);
  const hold = p ? 4000 + p.text.length * 60 : 0;
  const left = p ? p.at + hold - Date.now() : 0;
  useEffect(() => { if (!active && p && left > 0) { const t = setTimeout(() => force(x => x + 1), left + 50); return () => clearTimeout(t); } }, [active, left > 0]);
  if (!on || !p || (!active && left <= 0)) return null;
  return html`<${Phrase} text=${p.text} />`;
}

function Dialog({ title, text, children, onClose }) {
  return html`<div class="dialog-wrap" onClick=${e => e.target === e.currentTarget && onClose()}>
    <div class="dialog">${title && html`<h3>${title}</h3>`}${text && html`<div class="muted">${typo(text)}</div>`}${children}</div></div>`;
}
function Confirm({ title, text, ok = 'Удалить', onOk, onClose }) {
  return html`<${Dialog} title=${title} text=${text} onClose=${onClose}>
    <div class="row"><button class="btn soft" onClick=${onClose}>Отмена</button><button class="btn" onClick=${() => { onClose(); onOk(); }}>${ok}</button></div><//>`;
}
function Prompt({ title, init = '', placeholder, ok = 'Готово', onOk, onClose, multi }) {
  const [v, setV] = useState(init);
  const ref = useRef();
  useEffect(() => { setTimeout(() => ref.current && ref.current.focus(), 50); }, []);
  return html`<${Dialog} title=${title} onClose=${onClose}>
    ${multi ? html`<textarea ref=${ref} class="field" value=${v} placeholder=${placeholder} onInput=${e => setV(e.target.value)} />`
      : html`<input ref=${ref} class="field" value=${v} placeholder=${placeholder} onInput=${e => setV(e.target.value)} onKeyDown=${e => e.key === 'Enter' && v.trim() && (onClose(), onOk(v.trim()))} />`}
    <div class="row"><button class="btn soft" onClick=${onClose}>Отмена</button><button class="btn" disabled=${!v.trim()} onClick=${() => { onClose(); onOk(v.trim()); }}>${ok}</button></div><//>`;
}

function Menu({ items, onClose }) {
  return html`<div class="scrim" onClick=${onClose}></div><div class="menu">${items.map(([icon, label, fn]) =>
    html`<button onClick=${() => { onClose(); fn(); }}><${Icon} n=${icon} s=${20} c="var(--muted)" />${label}</button>`)}</div>`;
}

function micError(e) {
  if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError'))
    return isIOS ? 'Нет доступа к микрофону. Открой Настройки iPhone → Safari → Микрофон → «Разрешить», потом попробуй ещё раз.'
      : 'Нет доступа к микрофону. Разреши его в настройках браузера для этого сайта.';
  if (e && e.name === 'NotFoundError') return 'Микрофон не найден.';
  return 'Не получилось включить микрофон: ' + (e && e.message || e);
}
async function startRec(ideaId, rubricId) {
  try { await R.start(ideaId, rubricId); } catch (e) { toast(micError(e)); }
}

// ---------- главный ----------
const filter = { rubric: ALL, status: null, query: '', searching: false };

function Home({ d }) {
  const [, force] = useState(0);
  const f = filter; const upd = p => { Object.assign(f, p); force(x => x + 1); };
  const [inspire, setInspire] = useState(null);
  const ms = useStore(M.subscribe, M.getState);
  const ts = useStore(T.subscribe, T.getStatus);
  const q = f.query.trim().toLowerCase();
  const ideas = S.active(d)
    .filter(i => !i.items.some(t => t.tx === 'RECORDING'))
    .filter(i => inRubric(d, i, f.rubric))
    .filter(i => !f.status || i.status === f.status)
    .filter(i => !q || (i.title + ' ' + S.allText(i)).toLowerCase().includes(q))
    .sort((a, b) => b.updated - a.updated);
  const pending = d.ideas.reduce((s, i) => s + i.items.filter(t => t.type === 'VOICE' && t.tx === 'PENDING').length, 0);
  const inbox = S.active(d).filter(i => inRubric(d, i, INBOX)).length;
  const activeRubric = S.rubric(f.rubric, d)?.id || null;

  let banner = null;
  if (isIOS && !standalone()) banner = html`<${Banner} text="Добавь приложение на экран «Домой», так заметки надёжнее хранятся. Нажми, покажу как." onClick=${() => nav('/install')} />`;
  else if (ms.loading) banner = html`<${Banner} text=${'Скачиваю модель распознавания: ' + Math.floor(ms.done * 100 / (ms.total || 1)) + '%. Записывать уже можно, текст появится после загрузки.'} onClick=${() => nav('/settings')} />`;
  else if (ms.error) banner = html`<${Banner} alert text=${'Модель не скачалась: ' + ms.error + '. Нажми, чтобы попробовать ещё раз.'} onClick=${() => nav('/settings')} />`;
  else if (pending > 0 && ts.blocked) banner = html`<${Banner} alert text=${plural(pending, 'запись ждёт', 'записи ждут', 'записей ждут') + ' расшифровки. ' + ts.blocked + '.'} onClick=${() => nav('/settings')} />`;

  return html`<div class="screen">
    <div class="top">
      ${f.searching ? html`
        <input class="field" style="flex:1;padding:10px 16px;border-radius:99px;background:var(--card);border:0" placeholder="Поиск по идеям"
          value=${f.query} onInput=${e => upd({ query: e.target.value })} ref=${el => el && !f.query && el.focus()} />
        <button class="ib" onClick=${() => upd({ searching: false, query: '' })}><${Icon} n="close" label="Закрыть поиск" /></button>` : html`
        <h1 class="h-title">${titleOf(d)}</h1>
        <button class="ib" onClick=${() => nav('/give')}><${Icon} n="bulb" c="var(--warm)" label="Дай идею" /></button>
        <button class="ib" onClick=${() => upd({ searching: true })}><${Icon} n="search" label="Поиск" /></button>
        <button class="ib" onClick=${() => nav('/settings')}><${Icon} n="settings" label="Настройки" /></button>`}
    </div>
    <div class="chips">
      <button class=${'chip' + (f.rubric === ALL ? ' on' : '')} onClick=${() => upd({ rubric: ALL })}>Все</button>
      <button class=${'chip' + (f.rubric === INBOX ? ' on' : '')} onClick=${() => upd({ rubric: INBOX })}>${inbox ? 'Входящие · ' + inbox : 'Входящие'}</button>
      ${d.rubrics.map(r => html`<button key=${r.id} class=${'chip' + (f.rubric === r.id ? ' on' : '')} onClick=${() => upd({ rubric: r.id })}><${Dot} c=${cssColor(r.color)} />${r.name}</button>`)}
    </div>
    <div class="chips" style="padding-top:0;gap:6px">
      <button class=${'schip' + (!f.status ? ' on' : '')} onClick=${() => upd({ status: null })}>Любой статус</button>
      ${S.STATUSES.map(([k, l]) => html`<button class=${'schip' + (f.status === k ? ' on' : '')} onClick=${() => upd({ status: f.status === k ? null : k })}>${l}</button>`)}
    </div>
    ${banner}
    ${ideas.length === 0 ? html`<div class="empty">${S.active(d).length === 0 ? 'Здесь будут твои мысли.\nНажми на кнопку и скажи первую.' : q ? 'Ничего не нашлось' : 'Тут пока пусто.\nСамое время записать что-нибудь.'}</div>`
      : html`<div class="scroll"><div class="list">${ideas.map(i => html`<${IdeaCard} key=${i.id} d=${d} i=${i} />`)}</div></div>`}
    <div class="bar">
      <button class="round" onClick=${() => newTextIdea(activeRubric)}><${Icon} n="text" label="Написать" /></button>
      <button class="rec-btn" onClick=${() => startRec(null, activeRubric)}><${Icon} n="mic" s=${38} label="Записать мысль" /></button>
      <button class="round" onClick=${() => setInspire(nextPhrase())}><${Icon} n="spark" c="var(--warm)" label="Вдохновение" /></button>
    </div>
    ${inspire && html`<div class="overlay" onClick=${() => setInspire(null)}>
      <${Icon} n="spark" s=${40} c="var(--warm)" />
      <div class="inspire" style="margin-top:20px" onClick=${e => { e.stopPropagation(); setInspire(nextPhrase()); }}>${inspire}</div>
      <div class="small muted" style="margin-top:28px">${typo('Коснись фразы, чтобы взять другую')}</div></div>`}
  </div>`;
}

function newTextIdea(rubricId) {
  const it = S.newItem('TEXT');
  const i = S.newIdea(rubricId, [it]);
  S.addIdea(i);
  editOnOpen = it.id;
  nav('/idea/' + i.id);
}
let editOnOpen = null;

function IdeaCard({ d, i }) {
  const r = S.rubric(i.rubricId, d);
  const title = S.displayTitle(i);
  let body = i.items.filter(t => t.text.trim() && t.type !== 'LINK').map(t => t.text.trim()).join(' ');
  if (!i.title.trim()) body = body.replace(title.replace(/…$/, ''), '').trim();
  const tx = i.items.some(t => t.type === 'VOICE' && (t.tx === 'PENDING' || t.tx === 'RUNNING'));
  const cnt = n => i.items.filter(t => t.type === n).length;
  return html`<button class="card idea-card" onClick=${() => nav('/idea/' + i.id)}>
    <div class="meta"><${Dot} c=${r ? cssColor(r.color) : 'var(--muted)'} s=${8} /><span>${r ? r.name : 'Входящие'}</span>
      <span class="grow">· ${formatDate(i.created)}</span><span class="pill" style=${{ background: `color-mix(in srgb, ${statusColor(i.status)} 16%, transparent)`, color: statusColor(i.status) }}>${S.statusLabel(i.status)}</span></div>
    <div class="t2">${title}</div>
    ${body && html`<div class="b2">${body}</div>`}
    ${tx && title !== 'Расшифровываю…' && html`<div class="lbl" style="margin-top:6px">Расшифровываю…</div>`}
    <${LingerPhrase} k=${i.id} active=${tx} />
    ${(cnt('VOICE') + cnt('IMAGE') + cnt('LINK')) > 0 && html`<div class="counts">
      ${cnt('VOICE') > 0 && html`<span><${Icon} n="mic" s=${16} /> ${cnt('VOICE')}</span>`}
      ${cnt('IMAGE') > 0 && html`<span><${Icon} n="image" s=${16} /> ${cnt('IMAGE')}</span>`}
      ${cnt('LINK') > 0 && html`<span><${Icon} n="link" s=${16} /> ${cnt('LINK')}</span>`}</div>`}
  </button>`;
}

// ---------- идея ----------
function ideaForAi(d, i) {
  const rubric = S.rubric(i.rubricId, d)?.name || 'без рубрики';
  const notes = i.items.filter(t => (t.type === 'TEXT' || t.type === 'VOICE') && t.text.trim()).map(t => '- ' + t.text.trim()).join('\n') || '(пока нет)';
  const links = i.items.filter(t => t.type === 'LINK').map(t => '- ' + t.url + (t.text.trim() ? ` (${t.text.trim()})` : '')).join('\n');
  const imgs = i.items.filter(t => t.type === 'IMAGE').length;
  const refs = (links || '(нет)') + (imgs ? `\n(к идее есть картинки-референсы: ${imgs} шт., пришлю отдельно)` : '');
  return d.settings.aiTemplate.replaceAll('{рубрика}', rubric).replaceAll('{название}', S.displayTitle(i)).replaceAll('{заметки}', notes)
    .replaceAll('{ссылки}', refs).replaceAll('{статус}', S.statusLabel(i.status)).replaceAll('{формат}', 'не выбран, предложи подходящий');
}

function autoGrow(el) { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }

function IdeaScreen({ d, id }) {
  const i = S.idea(id, d);
  const [editing, setEditing] = useState(() => { const e = editOnOpen; editOnOpen = null; return e; });
  const [menu, setMenu] = useState(false);
  const [rubMenu, setRubMenu] = useState(false);
  const [ask, setAsk] = useState(null);
  const [viewer, setViewer] = useState(null);
  const fileRef = useRef();
  const editingRef = useRef(editing); editingRef.current = editing;

  // пустую идею не оставляем
  useEffect(() => () => {
    A.stopPlay();
    const cur = S.idea(id);
    if (!cur || R.current()?.ideaId === id) return;
    const empty = !cur.title.trim() && cur.items.every(t => t.type === 'TEXT' && !t.text.trim());
    if (empty) S.deleteIdea(id);
    else cur.items.filter(t => t.type === 'TEXT' && !t.text.trim()).forEach(t => S.removeItem(id, t.id));
  }, [id]);

  if (!i) { setTimeout(() => nav('/'), 0); return null; }
  const r = S.rubric(i.rubricId, d);
  const trash = () => { S.trashIdea(id); toast('Идея в «Удалённых»'); back(); };

  async function addImages(files) {
    let bad = 0;
    for (const f of files) {
      try {
        const blob = await shrinkImage(f);
        const it = S.newItem('IMAGE'); it.file = it.id + '.jpg';
        await S.putFile(it.file, blob);
        S.addItem(id, it);
      } catch { bad++; }
    }
    if (bad) toast('Часть картинок не получилось добавить');
  }

  return html`<div class="screen">
    <div class="top" style="padding-left:4px;position:relative">
      <button class="ib" style="color:var(--ink)" onClick=${back}><${Icon} n="back" label="Назад" /></button>
      <span style="flex:1"></span>
      <button class="chip" onClick=${async () => { await copy(ideaForAi(S.get(), S.idea(id))); toast('Скопировано. Вставь в Claude или ChatGPT'); }}><${Icon} n="copy" s=${18} />Для ИИ</button>
      <button class="ib" onClick=${() => setMenu(true)}><${Icon} n="more" label="Ещё" /></button>
      ${menu && html`<${Menu} onClose=${() => setMenu(false)} items=${[['del', 'Удалить идею', () => setAsk({ title: 'Удалить идею?', text: 'Идея уйдёт в «Удалённые» вместе с голосовыми и картинками. Вернуть её можно в настройках.', ok: trash })]]} />`}
    </div>
    <div class="scroll"><div class="pad" style="padding:0 20px 24px;display:flex;flex-direction:column;gap:12px">
      <textarea class="title-in" rows="1" placeholder=${S.displayTitle(i)} value=${i.title} ref=${autoGrow}
        onInput=${e => { autoGrow(e.target); S.updateIdea(id, x => ({ ...x, title: e.target.value })); }} />
      <div style="display:flex;align-items:center;gap:10px;position:relative">
        <button class="chip" onClick=${() => setRubMenu(true)}><${Dot} c=${r ? cssColor(r.color) : 'var(--muted)'} />${r ? r.name : 'Входящие'}</button>
        <span class="lbl">${formatDate(i.created)}</span>
        ${rubMenu && html`<div class="scrim" onClick=${() => setRubMenu(false)}></div><div class="menu" style="left:0;right:auto;top:46px">
          <button onClick=${() => { setRubMenu(false); S.updateIdea(id, x => ({ ...x, rubricId: null })); }}><${Dot} c="var(--muted)" />Входящие</button>
          ${d.rubrics.map(rr => html`<button onClick=${() => { setRubMenu(false); S.updateIdea(id, x => ({ ...x, rubricId: rr.id })); }}><${Dot} c=${cssColor(rr.color)} />${rr.name}</button>`)}</div>`}
      </div>
      <div class="chips" style="padding:0">${S.STATUSES.map(([k]) => html`<${Pill} s=${k} filled=${i.status === k} onClick=${() => S.updateIdea(id, x => ({ ...x, status: k }))} />`)}</div>
      ${i.items.map(t => html`<${ItemCard} key=${t.id} i=${i} t=${t} editing=${editing === t.id} setEditing=${setEditing} setAsk=${setAsk} onTrash=${trash} onImage=${setViewer} />`)}
    </div></div>
    <div class="addbar">
      <button onClick=${() => { setEditing(null); startRec(id, null); }}><${Icon} n="mic" s=${26} c="var(--accent)" />Голос</button>
      <button onClick=${() => { const it = S.newItem('TEXT'); S.addItem(id, it); setEditing(it.id); }}><${Icon} n="text" s=${26} c="var(--ink)" />Текст</button>
      <button onClick=${() => fileRef.current.click()}><${Icon} n="image" s=${26} c="var(--ink)" />Фото</button>
      <button onClick=${() => setAsk({ link: true })}><${Icon} n="link" s=${26} c="var(--ink)" />Ссылка</button>
      <input ref=${fileRef} type="file" accept="image/*" multiple hidden onChange=${e => { addImages([...e.target.files]); e.target.value = ''; }} />
    </div>
    ${ask && ask.link && html`<${LinkDialog} onClose=${() => setAsk(null)} onOk=${(url, note) => S.addItem(id, S.newItem('LINK', { url, text: note }))} />`}
    ${ask && !ask.link && html`<${Confirm} title=${ask.title} text=${ask.text} onOk=${ask.ok} onClose=${() => setAsk(null)} />`}
    ${viewer && html`<div class="overlay" style="background:#000;padding:0" onClick=${() => { URL.revokeObjectURL(viewer); setViewer(null); }}><img src=${viewer} style="max-width:100%;max-height:100%;object-fit:contain" /></div>`}
  </div>`;
}

function LinkDialog({ onOk, onClose }) {
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const ok = findUrls(url).length > 0 || /\.\w{2,}/.test(url);
  return html`<${Dialog} title="Ссылка" onClose=${onClose}>
    <input class="field" placeholder="Вставь ссылку" value=${url} onInput=${e => setUrl(e.target.value)} inputmode="url" autocapitalize="off" />
    <input class="field" style="margin-top:10px" placeholder="Заметка к ссылке (можно пусто)" value=${note} onInput=${e => setNote(e.target.value)} />
    <div class="row"><button class="btn soft" onClick=${onClose}>Отмена</button>
      <button class="btn" disabled=${!ok} onClick=${() => { onClose(); onOk(normalizeUrl(findUrls(url)[0] || url.trim()), note.trim()); }}>Добавить</button></div><//>`;
}

async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('jpeg')), 'image/jpeg', 0.86));
}

function useFileUrl(name) {
  const [u, setU] = useState(null);
  useEffect(() => { let url = null, live = true; S.getFile(name).then(b => { if (b && live) { url = URL.createObjectURL(b); setU(url); } }); return () => { live = false; url && URL.revokeObjectURL(url); }; }, [name]);
  return u;
}

function ItemCard({ i, t, editing, setEditing, setAsk, onTrash, onImage }) {
  const [menu, setMenu] = useState(false);
  const playing = useStore(A.onPlaying, A.playing);
  const img = t.type === 'IMAGE' ? useFileUrl(t.file) : null;
  const last = !i.title.trim() && !i.items.some(x => x.id !== t.id && (x.type !== 'TEXT' || x.text.trim()));
  const del = () => last
    ? setAsk({ title: 'Удалить идею?', text: 'Это единственная запись в идее. Идея уйдёт в «Удалённые», вернуть её можно в настройках.', ok: onTrash })
    : setAsk({ title: 'Удалить?', text: t.type === 'VOICE' ? 'Голосовая запись и её текст удалятся.' : t.type === 'IMAGE' ? 'Картинка удалится из идеи.' : 'Заметка удалится.', ok: () => S.removeItem(i.id, t.id) });
  const items = [];
  if (t.type === 'VOICE' && (t.tx === 'DONE' || t.tx === 'ERROR')) items.push(['refresh', 'Расшифровать заново', () => T.retry(i.id, t.id)]);
  items.push(['del', 'Удалить', del]);
  const label = { TEXT: 'Заметка', IMAGE: 'Референс', LINK: 'Ссылка' }[t.type];

  let body;
  if (t.type === 'VOICE') {
    if (['PENDING', 'RUNNING', 'RECORDING'].includes(t.tx)) body = html`<div style="margin-top:8px"><div class="lbl" style="font-size:15px;font-weight:600">${t.tx === 'RUNNING' ? 'Расшифровываю…' : t.tx === 'RECORDING' ? 'Идёт запись…' : 'Расшифровка в очереди'}</div><${LingerPhrase} k=${t.id} active=${true} /></div>`;
    else if (t.tx === 'ERROR') body = html`<div style="margin-top:8px;display:flex;align-items:center;gap:8px"><span class="muted" style="flex:1">${typo('Не получилось расшифровать. Аудио сохранено.')}</span><button class="tbtn" onClick=${() => T.retry(i.id, t.id)}>Повторить</button></div>`;
    else body = html`<${EditText} i=${i} t=${t} editing=${editing} setEditing=${setEditing} hint="Слов не разобрать. Можно дописать текстом." /><${LingerPhrase} k=${t.id} active=${false} />`;
  } else if (t.type === 'TEXT') body = html`<${EditText} i=${i} t=${t} editing=${editing} setEditing=${setEditing} hint="Напиши мысль" />`;
  else if (t.type === 'IMAGE') body = img && html`<img class="ref" src=${img} onClick=${async () => { const b = await S.getFile(t.file); b && onImage(URL.createObjectURL(b)); }} />`;
  else body = html`<a href=${t.url} target="_blank" rel="noopener" style="display:block;margin-top:8px;text-decoration:none">
    <div style="display:flex;gap:6px;align-items:center;font-weight:600"><${Icon} n="link" s=${18} />${domain(t.url)}</div>
    <div class="small muted" style="word-break:break-all">${t.url}</div>${t.text && html`<div style="color:var(--ink);margin-top:4px">${t.text}</div>`}</a>`;

  return html`<div class="item" style="position:relative">
    <div class="item-head">
      ${t.type === 'VOICE' ? html`<button class="play" onClick=${() => A.toggle(t.id, t.file)}><${Icon} n=${playing === t.id ? 'pause' : 'play'} label="Слушать" /></button>
        <b style="font-weight:600">${formatDuration(t.durationMs)}</b><span class="lbl">· ${formatDate(t.created)}</span>`
      : html`<span class="lbl">${label} · ${formatDate(t.created)}</span>`}
      <span style="flex:1"></span>
      <button class="ib" style="width:36px;height:36px" onClick=${() => setMenu(true)}><${Icon} n="more" s=${20} label="Ещё" /></button>
      ${menu && html`<${Menu} items=${items} onClose=${() => setMenu(false)} />`}
    </div>
    <div class="item-body">${body}</div>
  </div>`;
}

function EditText({ i, t, editing, setEditing, hint }) {
  const [v, setV] = useState(t.text);
  const ref = useRef();
  useEffect(() => { if (editing) { setV(t.text); setTimeout(() => { if (ref.current) { autoGrow(ref.current); ref.current.focus(); } }, 30); } }, [editing]);
  const save = () => { if (v !== t.text) S.updateItem(i.id, t.id, x => ({ ...x, text: v })); };
  if (editing) return html`<div style="margin-top:8px">
    <textarea ref=${ref} class="edit" rows="2" placeholder=${hint} value=${v} onInput=${e => { setV(e.target.value); autoGrow(e.target); }} onBlur=${save} />
    <div style="text-align:right"><button class="tbtn" onClick=${() => { save(); setEditing(null); }}>Готово</button></div></div>`;
  return html`<div style="margin-top:8px" onClick=${() => setEditing(t.id)}>${t.text.trim() ? html`<${LinkText} text=${t.text} />` : html`<div class="txt muted">${hint}</div>`}</div>`;
}

// ---------- запись ----------
function RecordOverlay({ c }) {
  const [, tick] = useState(0);
  useEffect(() => { let raf; const f = () => { tick(x => x + 1); raf = requestAnimationFrame(f); }; raf = requestAnimationFrame(f); return () => cancelAnimationFrame(raf); }, []);
  const lv = Math.min(1, Math.sqrt(R.getLevel()) * 1.4);
  return html`<div class="rec">
    <div class="lbl" style="font-size:17px;font-weight:600">${c.newIdea ? 'Новая мысль' : 'Дополнение к идее'}</div>
    <div class="timer">${formatDuration(R.elapsed())}</div>
    <div class="stage">
      <div class="c1" style=${{ transform: `scale(${0.55 + lv * 0.45})` }}></div>
      <div class="c2" style=${{ transform: `scale(${0.7 + lv * 0.3})` }}></div>
      <button class="stop" onClick=${() => R.stop()}><${Icon} n="stop" s=${48} label="Стоп" /></button>
    </div>
    <div class="muted" style="text-align:center;font-size:15px;line-height:21px;max-width:340px">${typo('Говори. Не блокируй экран, пока записываешь. Если заблокируешь, всё сказанное до этого сохранится.')}</div>
    <button class="tbtn muted" style="margin-top:12px" onClick=${() => R.cancel()}>Отменить запись</button>
  </div>`;
}

function AfterRecord({ d, id, onDone }) {
  const i = S.idea(id, d);
  const [phrase] = useState(nextPhrase);
  const [adding, setAdding] = useState(false);
  if (!i) { onDone(); return null; }
  const pick = rid => { S.updateIdea(id, x => ({ ...x, rubricId: rid })); onDone(); };
  return html`<div class="screen" style="z-index:33"><div class="scroll" style="padding:24px">
    <h2 class="h-big" style="margin-top:24px">Сохранено</h2>
    ${d.settings.phrases && html`<div style="margin-top:12px"><${Phrase} text=${phrase} big /></div>`}
    <div class="lbl" style="font-size:17px;font-weight:600;margin:36px 0 14px">Куда отнести?</div>
    <div class="rub-grid">${d.rubrics.map(r => { const c = cssColor(r.color); const sel = i.rubricId === r.id;
      return html`<button class="rub" style=${{ background: sel ? c : `color-mix(in srgb, ${c} 18%, transparent)`, color: sel ? '#1B1830' : 'var(--ink)' }} onClick=${() => pick(r.id)}>${r.name}</button>`; })}
      <button class="rub" style="background:var(--card);height:60px;text-align:center;font-size:15px" onClick=${() => pick(null)}>Во входящие</button>
      <button class="rub" style="background:var(--card);height:60px;text-align:center;font-size:15px" onClick=${() => setAdding(true)}>+ Новая рубрика</button>
    </div>
    <div style="text-align:center;margin-top:24px"><button class="tbtn" onClick=${() => { onDone(); nav('/idea/' + id); }}>Открыть идею и дописать</button></div>
    <div style="text-align:center;margin-top:4px"><button class="tbtn muted" onClick=${() => { S.trashIdea(id); onDone(); toast('Запись удалена. Если передумаешь, она в «Удалённых»'); }}>Отменить запись</button></div>
  </div>
  ${adding && html`<${Prompt} title="Новая рубрика" placeholder="Название" onClose=${() => setAdding(false)} onOk=${n => pick(S.addRubric(n).id)} />`}
  </div>`;
}

// ---------- дай идею ----------
function Give({ d }) {
  const [rub, setRub] = useState(filter.rubric);
  const [n, setN] = useState(0);
  const pool = S.active(d).filter(i => i.status === 'RAW' && inRubric(d, i, rub)).sort((a, b) => a.created - b.created);
  const i = pool.length ? pool[n % pool.length] : null;
  const r = i && S.rubric(i.rubricId, d);
  return html`<div class="screen">
    <div class="top" style="padding-left:4px"><button class="ib" style="color:var(--ink)" onClick=${back}><${Icon} n="back" label="Назад" /></button><h1 class="h-title">Дай идею</h1></div>
    <div class="chips">
      <button class=${'chip' + (rub === ALL ? ' on' : '')} onClick=${() => { setRub(ALL); setN(0); }}>Все</button>
      <button class=${'chip' + (rub === INBOX ? ' on' : '')} onClick=${() => { setRub(INBOX); setN(0); }}>Входящие</button>
      ${d.rubrics.map(x => html`<button class=${'chip' + (rub === x.id ? ' on' : '')} onClick=${() => { setRub(x.id); setN(0); }}><${Dot} c=${cssColor(x.color)} />${x.name}</button>`)}
    </div>
    <div class="scroll" style="padding:20px">
      ${!i ? html`<div class="muted" style="text-align:center;margin-top:60px">${typo('Сырых идей здесь нет. Всё разобрано, самое время записать новую.')}</div>` : html`
        <div class="lbl">${(n % pool.length) + 1} из ${pool.length} · ждёт с ${formatDate(i.created)}</div>
        <div class="card" style="border-radius:26px;padding:20px;margin-top:10px">
          <div class="meta"><${Dot} c=${r ? cssColor(r.color) : 'var(--muted)'} />${r ? r.name : 'Входящие'}</div>
          <h2 class="h-mid" style="margin-top:10px">${S.displayTitle(i)}</h2>
          ${i.items.filter(t => t.text.trim() && t.type !== 'LINK').map(t => html`<div style="margin-top:10px"><${LinkText} text=${t.text} /></div>`)}
          ${i.items.filter(t => t.type === 'LINK').map(t => html`<div style="margin-top:8px"><${LinkText} text=${t.url} cls="txt small" /></div>`)}
        </div>`}
    </div>
    ${i && html`<div style="display:flex;gap:12px;padding:16px 16px calc(16px + env(safe-area-inset-bottom))">
      <button class="btn ghost" onClick=${() => setN(n + 1)}>Другую</button>
      <button class="btn" onClick=${() => { S.updateIdea(i.id, x => ({ ...x, status: 'WORK' })); history.replaceState(null, '', '#/idea/' + i.id); dispatchEvent(new HashChangeEvent('hashchange')); }}>Беру</button></div>`}
  </div>`;
}

// ---------- удалённые ----------
function Trash({ d }) {
  const [ask, setAsk] = useState(null);
  const list = S.trash(d);
  return html`<div class="screen">
    <div class="top" style="padding-left:4px"><button class="ib" style="color:var(--ink)" onClick=${back}><${Icon} n="back" label="Назад" /></button>
      <h1 class="h-title">Удалённые</h1>${list.length > 0 && html`<button class="tbtn" onClick=${() => setAsk({ title: 'Очистить «Удалённые»?', text: 'Все идеи отсюда сотрутся насовсем вместе с голосовыми и картинками.', ok: S.emptyTrash })}>Очистить</button>`}</div>
    <div class="scroll">${list.length === 0 ? html`<div class="empty" style="margin-top:80px">Здесь пусто</div>` : html`<div class="list" style="padding-bottom:40px">
      ${list.map(i => html`<div class="card"><div class="lbl">Удалена ${formatDate(i.deletedAt)}</div><div class="t2">${S.displayTitle(i)}</div>
        <div style="display:flex;gap:8px;margin-top:10px"><button class="actbtn primary" onClick=${() => { S.restoreIdea(i.id); toast('Идея вернулась'); }}>Вернуть</button>
        <button class="actbtn" onClick=${() => setAsk({ title: 'Стереть насовсем?', text: 'Идея и её файлы удалятся без возможности вернуть.', ok: () => S.deleteIdea(i.id) })}>Стереть</button></div></div>`)}</div>`}</div>
    ${ask && html`<${Confirm} title=${ask.title} text=${ask.text} onOk=${ask.ok} onClose=${() => setAsk(null)} />`}
  </div>`;
}

// ---------- установка на iPhone ----------
function Install() {
  return html`<div class="screen">
    <div class="top" style="padding-left:4px"><button class="ib" style="color:var(--ink)" onClick=${back}><${Icon} n="back" label="Назад" /></button><h1 class="h-title">На экран «Домой»</h1></div>
    <div class="scroll" style="padding:8px 20px 40px"><${InstallSteps} /></div></div>`;
}
function InstallSteps() {
  return html`<div class="muted">${typo('Так приложение откроется на весь экран, как обычное, и заметки будут храниться надёжнее. Открой эту страницу именно в Safari.')}</div>
    <ol class="steps">
      <li><span>${typo('Нажми кнопку «Поделиться»')} <span class="ios-ic"><${Icon} n="share" s=${18} /></span> ${typo('внизу экрана (на iPad вверху).')}</span></li>
      <li><span>${typo('Прокрути список вниз и выбери «На экран «Домой»»')} <span class="ios-ic"><${Icon} n="addbox" s=${18} /></span>.</span></li>
      <li><span>${typo('Нажми «Добавить» в правом верхнем углу.')}</span></li>
      <li><span>${typo('Открывай заметки с иконки на экране «Домой», а не из Safari: это два разных хранилища.')}</span></li>
    </ol>`;
}

// ---------- первый запуск ----------
function Onboarding({ d }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState(d.settings.name);
  const [names, setNames] = useState(['', '', '']);
  const [phrase] = useState(nextPhrase);
  const ex = ['Например, личное', 'Например, работа', 'Например, путешествия', 'Например, лайфхаки', 'Например, закулисье'];
  const total = 3;
  useEffect(() => { if (step === 2 && !S.get().settings.model) S.settings(s => ({ ...s, model: 'base' })); }, [step]);
  return html`<div class="screen"><div class="scroll" style="padding:24px">
    <div class="lbl" style="margin-top:24px">${step + 1} из ${total}</div>
    ${step === 0 && html`
      <h1 class="h-big" style="margin-top:8px">Привет!</h1>
      <div style="margin-top:14px"><${Phrase} text=${phrase} big /></div>
      <p class="muted" style="margin-top:24px">${typo('Как подписать твои заметки? Напиши имя так, как оно звучит после слова «Заметки».')}</p>
      <input class="field" placeholder="Например, Кристи" value=${name} maxlength="30" autocapitalize="words" onInput=${e => setName(e.target.value)} />
      <div class="h-title" style="margin:10px 0 24px">${name.trim() ? 'Заметки ' + name.trim() : 'Заметки блогера'}</div>
      ${isIOS && !standalone() && html`<div class="card" style="margin-bottom:20px"><b>${typo('Сначала добавь на экран «Домой»')}</b><${InstallSteps} /></div>`}
      <button class="btn" onClick=${() => { S.settings(s => ({ ...s, name: name.trim() })); setStep(1); }}>Дальше</button>`}
    ${step === 1 && html`
      <h1 class="h-big" style="margin-top:8px">О чём твой блог?</h1>
      <p class="muted">${typo('Задай рубрики: темы, про которые ты рассказываешь. После записи мысль относится к рубрике одним касанием. Их можно поменять в любой момент.')}</p>
      ${names.map((v, k) => html`<div style="display:flex;gap:6px;align-items:center;margin:10px 0">
        <input class="field" placeholder=${ex[k] || 'Ещё рубрика'} value=${v} onInput=${e => { const n = [...names]; n[k] = e.target.value; setNames(n); }} />
        ${names.length > 1 && html`<button class="ib" onClick=${() => setNames(names.filter((_, j) => j !== k))}><${Icon} n="close" label="Убрать" /></button>`}</div>`)}
      <button class="tbtn" onClick=${() => setNames([...names, ''])}>+ Ещё рубрика</button>
      <div style="height:20px"></div>
      <button class="btn" disabled=${!names.some(x => x.trim())} onClick=${() => { if (!S.get().rubrics.length) names.filter(x => x.trim()).forEach(S.addRubric); setStep(2); }}>Дальше</button>`}
    ${step === 2 && html`
      <h1 class="h-big" style="margin-top:8px">Голос в текст</h1>
      <p class="muted">${typo('Расшифровка работает прямо на телефоне: без подписок, записи никуда не уходят. Для этого один раз скачивается модель распознавания. Лучше по Wi-Fi.')}</p>
      <${ModelPicker} d=${d} />
      <div style="height:20px"></div>
      <button class="btn" onClick=${() => { const k = S.get().settings.model || 'base'; M.download(k).then(() => T.kick()).catch(() => {}); S.settings(s => ({ ...s, onboarded: true })); }}>Скачать и начать</button>
      <div style="text-align:center;margin-top:6px"><button class="tbtn muted" onClick=${() => S.settings(s => ({ ...s, onboarded: true }))}>Позже, в настройках</button></div>
      <p class="small muted">${typo('Записывать можно уже сейчас: голосовые сохранятся и расшифруются, когда модель скачается.')}</p>`}
  </div></div>`;
}

function ModelPicker({ d }) {
  const [inst, setInst] = useState({});
  useEffect(() => { Promise.all(M.MODELS.map(m => M.installed(m.key))).then(v => setInst(Object.fromEntries(M.MODELS.map((m, k) => [m.key, v[k]])))); }, [d.settings.model, M.getState().loading]);
  const sel = d.settings.model || 'base';
  return html`<div style="display:flex;flex-direction:column;gap:10px">${M.MODELS.map(m => html`
    <button class=${'opt' + (sel === m.key ? ' on' : '')} onClick=${() => { S.settings(s => ({ ...s, model: m.key })); T.kick(); }}>
      <span class="radio"></span><span><b>${m.title}</b> <span class="muted">· ${m.mb} МБ${inst[m.key] ? ' · скачана' : ''}</span>
      <div class="small muted" style="margin-top:4px">${typo(m.note)}</div></span></button>`)}</div>`;
}

// ---------- настройки ----------
function Fold({ title, open0 = false, children }) {
  const [open, setOpen] = useState(open0);
  return html`<div class=${'fold' + (open ? ' open' : '')}><button onClick=${() => setOpen(!open)}><span>${title}</span><${Icon} n="expand" /></button>
    ${open && html`<div class="in">${children}</div>`}</div>`;
}
const Switch = ({ on, onClick, label }) => html`<div class="row-set"><span class="grow">${label}</span><button class=${'switch' + (on ? ' on' : '')} role="switch" aria-checked=${on} onClick=${onClick}></button></div>`;

function Settings({ d }) {
  const ms = useStore(M.subscribe, M.getState);
  const [inst, setInst] = useState(null);
  const [ask, setAsk] = useState(null);
  const [est, setEst] = useState(null);
  const importRef = useRef();
  const key = d.settings.model || 'base';
  useEffect(() => { M.installed(key).then(setInst); navigator.storage?.estimate?.().then(setEst).catch(() => {}); }, [key, ms.loading]);
  const s = d.settings;
  const set = p => S.settings(x => ({ ...x, ...p }));

  return html`<div class="screen">
    <div class="top" style="padding-left:4px"><button class="ib" style="color:var(--ink)" onClick=${back}><${Icon} n="back" label="Назад" /></button><h1 class="h-title">Настройки</h1></div>
    <div class="scroll" style="padding:8px 0 40px">
      <${Fold} title="Внешний вид">
        <div class="lbl">Подпись в заголовке</div>
        <input class="field" placeholder="Например, Кристи" value=${s.name} maxlength="30" onInput=${e => set({ name: e.target.value })} />
        <div class="small muted">Будет: ${titleOf(d)}</div>
        <div class="lbl">Тема</div>
        ${[['system', 'Как в телефоне'], ['dark', 'Тёмная'], ['light', 'Светлая']].map(([k, l]) => html`<button class=${'opt' + (s.theme === k ? ' on' : '')} onClick=${() => set({ theme: k })}><span class="radio"></span>${l}</button>`)}
      <//>
      <${Fold} title="Рубрики"><${Rubrics} d=${d} setAsk=${setAsk} /><//>
      <${Fold} title="Распознавание речи" open0=${!inst}>
        <${ModelPicker} d=${d} />
        ${ms.loading ? html`<div><div class="pbar"><i style=${{ width: (ms.done * 100 / (ms.total || 1)) + '%' }}></i></div>
          <div class="small muted" style="margin-top:6px">Скачиваю: ${Math.round(ms.done / 1e6)} из ${Math.round(ms.total / 1e6)} МБ. ${typo('Не закрывай приложение, пока идёт загрузка.')}</div></div>`
          : inst ? html`<div class="small muted">${typo('Модель скачана и работает без интернета.')}</div>
            <button class="actbtn" onClick=${() => setAsk({ title: 'Удалить модель?', text: 'Освободится место, но расшифровка не будет работать, пока не скачаешь снова.', ok: async () => { await M.remove(key); setInst(false); } })}>Удалить модель</button>`
          : html`${ms.error && html`<${Banner} alert text=${'Не скачалось: ' + ms.error} />`}
            <button class="actbtn primary" onClick=${() => M.download(key).then(() => T.kick()).catch(() => {})}>Скачать модель</button>`}
        ${est && html`<div class="small muted">Занято приложением: ${Math.round(est.usage / 1e6)} МБ</div>`}
      <//>
      <${Fold} title="Фразы и шаблон для ИИ">
        <${Switch} label="Фразы для вдохновения" on=${s.phrases} onClick=${() => set({ phrases: !s.phrases })} />
        <div class="lbl">${typo('Шаблон «Для ИИ». Подстановки: {рубрика}, {название}, {заметки}, {ссылки}, {статус}')}</div>
        <textarea class="field" style="min-height:220px;font-size:14px" value=${s.aiTemplate} onInput=${e => set({ aiTemplate: e.target.value })} />
      <//>
      <${Fold} title="Резервная копия">
        <div class="small muted">${typo('Все идеи, голосовые и картинки одним файлом. Его можно отправить себе в Телеграм или Макс, а потом загрузить на этом или другом телефоне, в том числе на Android.')}</div>
        <button class="actbtn primary" onClick=${shareBackup}>Отправить копию</button>
        <button class="actbtn" onClick=${() => importRef.current.click()}>Загрузить из копии</button>
        <input ref=${importRef} type="file" accept=".zip,application/zip" hidden onChange=${e => { const f = e.target.files[0]; e.target.value = ''; f && setAsk({ title: 'Загрузить копию?', text: 'Все текущие идеи заменятся содержимым копии.', okText: 'Загрузить', ok: () => importBackup(f) }); }} />
      <//>
      <${Fold} title="Удалённые">
        <div class="small muted">${S.trash(d).length ? plural(S.trash(d).length, 'идея', 'идеи', 'идей') + ' можно вернуть' : 'Пусто'}</div>
        <button class="actbtn" onClick=${() => nav('/trash')}>Открыть «Удалённые»</button>
      <//>
      <${Fold} title="Помощь">
        ${isIOS && html`<button class="actbtn" onClick=${() => nav('/install')}>Как добавить на экран «Домой»</button>`}
        <div class="small muted">${typo('Если что-то не работает, нажми кнопку ниже: отчёт скопируется, и его можно переслать в мессенджере.')}</div>
        <button class="actbtn" onClick=${async () => { await copy(await report()); toast('Отчёт скопирован'); }}>Сообщить о проблеме</button>
      <//>
      <div class="small muted" style="padding:8px 20px">${typo('Заметки блогера, веб-версия ' + VERSION + '. Всё хранится только в этом телефоне.')}</div>
    </div>
    ${ask && html`<${Confirm} title=${ask.title} text=${ask.text} ok=${ask.okText || 'Удалить'} onOk=${ask.ok} onClose=${() => setAsk(null)} />`}
  </div>`;
}

function Rubrics({ d, setAsk }) {
  const [edit, setEdit] = useState(null);
  return html`${d.rubrics.map((r, k) => html`<div class="row-set">
      <${Dot} c=${cssColor(r.color)} s=${12} /><span class="grow" onClick=${() => setEdit(r)}>${r.name}</span>
      <button class="ib" style="width:36px;height:36px" disabled=${k === 0} onClick=${() => S.moveRubric(r.id, -1)}><${Icon} n="up" label="Выше" /></button>
      <button class="ib" style="width:36px;height:36px" disabled=${k === d.rubrics.length - 1} onClick=${() => S.moveRubric(r.id, 1)}><${Icon} n="down" label="Ниже" /></button>
      <button class="ib" style="width:36px;height:36px" onClick=${() => setEdit(r)}><${Icon} n="edit" s=${18} label="Переименовать" /></button>
      <button class="ib" style="width:36px;height:36px" onClick=${() => setAsk({ title: 'Удалить рубрику?', text: 'Идеи из неё перейдут во «Входящие».', ok: () => S.deleteRubric(r.id) })}><${Icon} n="del" s=${18} label="Удалить" /></button></div>`)}
    <button class="actbtn" onClick=${() => setEdit({})}>+ Новая рубрика</button>
    ${edit && html`<${Prompt} title=${edit.id ? 'Переименовать' : 'Новая рубрика'} init=${edit.name || ''} placeholder="Название" onClose=${() => setEdit(null)}
      onOk=${n => edit.id ? S.renameRubric(edit.id, n) : S.addRubric(n)} />`}`;
}

async function shareBackup() {
  try {
    await S.flush();
    const d = S.get();
    const enc = new TextEncoder();
    const entries = [{ name: 'notes.json', data: enc.encode(S.encode(d)) }];
    for (const i of d.ideas) for (const t of i.items) {
      if (!t.file) continue;
      const b = await S.getFile(t.file);
      if (b) entries.push({ name: (t.type === 'VOICE' ? 'audio/' : 'images/') + t.file, data: new Uint8Array(await b.arrayBuffer()) });
    }
    const date = new Date().toISOString().slice(0, 10);
    const file = new File([makeZip(entries)], `Заметки блогера ${date}.zip`, { type: 'application/zip' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Резервная копия заметок' });
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
  } catch (e) { if (e.name !== 'AbortError') toast('Не получилось сделать копию: ' + e.message); }
}

async function importBackup(f) {
  try {
    const entries = await readZip(f);
    const json = entries.find(e => e.name === 'notes.json');
    if (!json) throw new Error('в файле нет заметок');
    const next = S.decode(new TextDecoder().decode(json.data));
    for (const e of entries) {
      const m = e.name.match(/^(audio|images)\/([^/]+)$/);
      if (m && !m[2].includes('..')) await S.putFile(m[2], new Blob([e.data], { type: m[1] === 'audio' ? 'audio/wav' : 'image/jpeg' }));
    }
    const cur = S.get().settings;
    S.replaceAll({ ...next, settings: { ...next.settings, model: cur.model, onboarded: true } });
    toast('Загружено: ' + plural(next.ideas.length, 'идея', 'идеи', 'идей'));
    T.kick();
  } catch (e) { toast('Не получилось загрузить: ' + e.message); }
}

async function report() {
  const d = S.get();
  let est = '';
  try { const e = await navigator.storage.estimate(); est = Math.round(e.usage / 1e6) + ' из ' + Math.round(e.quota / 1e6) + ' МБ'; } catch {}
  const persisted = await navigator.storage?.persisted?.().catch(() => null);
  const models = await Promise.all(M.MODELS.map(async m => m.key + ':' + JSON.stringify(await M.meta(m.key))));
  const tx = {};
  d.ideas.forEach(i => i.items.forEach(t => { if (t.type === 'VOICE') tx[t.tx] = (tx[t.tx] || 0) + 1; }));
  return ['Отчёт «Заметки блогера» (веб ' + VERSION + ')', new Date().toString(), navigator.userAgent,
    'Экран «Домой»: ' + (standalone() ? 'да' : 'нет') + ', память: ' + est + ', надёжное хранение: ' + persisted,
    'Wake Lock: ' + !!navigator.wakeLock + ', микрофон: ' + !!navigator.mediaDevices?.getUserMedia,
    'Идей: ' + d.ideas.length + ', голосовые: ' + JSON.stringify(tx), 'Модель: ' + d.settings.model + ' ' + models.join(' '),
    '', ...readLog()].join('\n');
}

// ---------- корень ----------
function useRoute() {
  const [h, setH] = useState(location.hash);
  useEffect(() => { const f = () => setH(location.hash); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h.replace(/^#/, '') || '/';
}

function App() {
  const d = useStore(S.subscribe, S.get);
  const route = useRoute();
  const rec = useStore(R.subscribe, R.current);
  const [after, setAfter] = useState(null);
  const [t, setT] = useState(null);
  const [update, setUpdate] = useState(false);
  toastSet = text => { setT(text); clearTimeout(toastSet.tm); toastSet.tm = setTimeout(() => setT(null), Math.max(2500, text.length * 55)); };
  useEffect(() => {
    R.onAfter((id, reason) => {
      if (reason === 'short') toast('Запись слишком короткая, не сохранила');
      else if (id) { setAfter(id); if (reason === 'hidden') toast('Запись остановилась, когда экран погас. Всё сказанное сохранено.'); }
    });
    addEventListener('sw-update', () => setUpdate(true));
  }, []);
  useEffect(() => {
    const th = d.settings.theme;
    if (th === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', th);
  }, [d.settings.theme]);

  let screen;
  if (!d.settings.onboarded) screen = html`<${Onboarding} d=${d} />`;
  else if (route.startsWith('/idea/')) screen = html`<${IdeaScreen} key=${route} d=${d} id=${route.slice(6)} />`;
  else if (route === '/give') screen = html`<${Give} d=${d} />`;
  else if (route === '/settings') screen = html`<${Settings} d=${d} />`;
  else if (route === '/trash') screen = html`<${Trash} d=${d} />`;
  else if (route === '/install') screen = html`<${Install} />`;
  else screen = html`<${Home} d=${d} />`;

  return html`${screen}
    ${after && html`<${AfterRecord} d=${d} id=${after} onDone=${() => setAfter(null)} />`}
    ${rec && html`<${RecordOverlay} c=${rec} />`}
    ${update && !rec && html`<div class="toast" style="bottom:auto;top:calc(12px + env(safe-area-inset-top))" onClick=${() => { navigator.serviceWorker?.controller && navigator.serviceWorker.getRegistration().then(r => r?.waiting?.postMessage('skip')); }}>Есть обновление. Нажми, чтобы установить</div>`}
    ${t && html`<div class="toast" onClick=${() => setT(null)}>${t}</div>`}`;
}

export async function start() {
  await S.load();
  await R.recover();
  T.recover();
  render(html`<${App} />`, document.getElementById('app'));
  T.kick();
  log('запуск ' + VERSION + (standalone() ? ' (экран Домой)' : ''));
  // для проверок
  window.__bn = { S, M, T, R, A, idb, report };
}
