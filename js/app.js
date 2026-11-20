import { html, render, useState, useEffect, useRef } from './vendor/preact-htm.js';
import * as F from './format.js';
import { InspireOverlay } from './dust.js';
import * as S from './store.js';
import * as M from './models.js';
import * as T from './transcriber.js';
import * as R from './rec.js';
import * as A from './audio.js';
import * as idb from './idb.js';
import { Icon } from './icons.js';
import { DEFAULT_AI_TEMPLATE, DEFAULT_AI_TEMPLATE_IDEA, typo, nextPhrase, formatDate, formatDuration, plural, splitLinks, domain, findUrls, normalizeUrl } from './texts.js';
import { log, readLog } from './log.js';
import { makeZip, readZip } from './zip.js';

export const VERSION = '1.1.0';
const ALL = '*', INBOX = '-';

// ---------- общее ----------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const titleOf = d => d.settings.name.trim() ? 'Заметки ' + d.settings.name.trim() : 'Заметки блогера';
// короткое имя в одну строку с «Заметки», длинное целиком переносится на вторую
const titleWrap = d => { const t = titleOf(d); const k = t.indexOf(' '); return k < 0 ? t : t.slice(0, k + 1) + t.slice(k + 1).replace(/ /g, '\u00a0'); };
const onColor = hex => { const n = parseInt(hex.slice(1), 16); const l = (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255; return l > 0.6 ? '#1B1830' : '#fff'; };
const GLOWS = [['auto', 'Авто'], ['warm', 'Тёплая'], ['duo', 'Голубая + тёплая'], ['violet', 'Сиреневая'], ['blue', 'Голубая'], ['mint', 'Мятная'], ['pink', 'Розовая']];
const isDark = () => getComputedStyle(document.documentElement).colorScheme !== 'light';
/** Подсветка: для микрофона и для «Тт». Авто: микрофон жёлтый, «Тт» жёлтый в тёмной теме и сиреневый в светлой */
function glowColor(k, dark, text) {
  return ({ violet: '#B9A6FF', blue: '#8EC5FF', mint: '#8FE3C4', pink: '#FFA8C8', warm: '#FFC94D',
    duo: text ? '#FFC94D' : '#8EC5FF' })[k] || (text && !dark ? '#B9A6FF' : '#FFC94D');
}
const cssColor = S.cssColor;
const statusColor = s => ({ WORK: 'var(--warm)', DONE: 'var(--st-pub)' }[s] || 'var(--muted)');
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

function Menu({ items, onClose, style }) {
  // у нижнего края экрана меню открывается вверх
  const flip = el => { if (!el || el.dataset.f) return; el.dataset.f = 1; const r = el.getBoundingClientRect();
    if (r.bottom > innerHeight - 90) { el.style.top = 'auto'; el.style.bottom = '40px'; } };
  return html`<div class="scrim" onClick=${onClose}></div><div class="menu" ref=${flip} style=${style}>${items.map(([icon, label, fn, sub, color]) =>
    html`<button onClick=${() => { onClose(); fn(); }} style=${color ? { color } : null}><${Icon} n=${icon} s=${20} c=${color || 'var(--muted)'} />
      <span>${label}${sub && html`<div class="small muted">${sub}</div>`}</span></button>`)}</div>`;
}

/** Выбор идеи, в которую перенести записи */
function MergeDialog({ d, from, onPick, onClose }) {
  const [q, setQ] = useState('');
  const list = S.active(d).filter(i => i.id !== from.id)
    .filter(i => !q.trim() || (S.displayTitle(i) + ' ' + S.allText(i)).toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => b.updated - a.updated);
  return html`<${Dialog} title="Добавить к идее" onClose=${onClose}>
    <input class="field" placeholder="Поиск" value=${q} onInput=${e => setQ(e.target.value)} />
    <div style="max-height:50vh;overflow-y:auto;margin-top:10px;display:flex;flex-direction:column;gap:6px">
      ${list.length === 0 ? html`<div class="muted" style="padding:12px">Нет других идей</div>` : list.map(i => { const r = S.rubric(i.rubricId, d);
        return html`<button class="card" style="text-align:left;padding:12px 14px" onClick=${() => { onClose(); onPick(i); }}>
          <div class="meta">${r ? r.name : 'Входящие'} · ${formatDate(i.updated)}</div><div style="font-weight:600;margin-top:2px">${S.displayTitle(i)}</div></button>`; })}
    </div>
    <div class="row"><button class="btn soft" onClick=${onClose}>Отмена</button></div><//>`;
}

/** Перестановка зажатием: держишь, элемент приподнимается, ведёшь пальцем, соседи меняются местами */
function useReorder(ids, onCommit, vertical) {
  const st = useRef({ id: null, timer: 0, start: 0, offset: 0, els: {} });
  const [, force] = useState(0);
  const [order, setOrder] = useState(ids);
  const key = ids.join(',');
  useEffect(() => { if (!st.current.id) setOrder(ids); }, [key]);
  const props = id => ({
    ref: el => { if (el) st.current.els[id] = el; },
    onPointerDown: e => {
      const s = st.current; const p = vertical ? e.clientY : e.clientX;
      clearTimeout(s.timer);
      s.timer = setTimeout(() => { s.id = id; s.start = p; s.offset = 0; navigator.vibrate?.(20); force(x => x + 1); }, 420);
      s.down = p;
    },
    onPointerMove: e => {
      const s = st.current; const p = vertical ? e.clientY : e.clientX;
      if (!s.id) { if (Math.abs(p - s.down) > 8) clearTimeout(s.timer); return; }
      e.preventDefault();
      s.offset = p - s.start;
      setOrder(o => {
        const i = o.indexOf(s.id); let n = o;
        const sz = k => { const r = s.els[o[k]]?.getBoundingClientRect(); return r ? (vertical ? r.height : r.width) + 8 : 999; };
        if (s.offset > 0 && i < o.length - 1 && s.offset > sz(i + 1) / 2) { n = [...o]; n.splice(i + 1, 0, n.splice(i, 1)[0]); s.start += sz(i + 1); s.offset -= sz(i + 1); }
        else if (s.offset < 0 && i > 0 && -s.offset > sz(i - 1) / 2) { n = [...o]; n.splice(i - 1, 0, n.splice(i, 1)[0]); s.start -= sz(i - 1); s.offset += sz(i - 1); }
        return n;
      });
      force(x => x + 1);
    },
    onPointerUp: () => end(), onPointerCancel: () => end(),
    onContextMenu: e => e.preventDefault(),
    style: st.current.id === id ? { transform: `${vertical ? 'translateY' : 'translateX'}(${st.current.offset}px) scale(1.06)`, zIndex: 5, position: 'relative', opacity: 0.92, touchAction: 'none' } : { touchAction: st.current.id ? 'none' : null },
  });
  function end() {
    const s = st.current; clearTimeout(s.timer);
    if (!s.id) return;
    s.id = null; s.offset = 0; s.justDragged = Date.now();
    setOrder(o => { onCommit(o); return o; }); force(x => x + 1);
  }
  const dragged = () => Date.now() - (st.current.justDragged || 0) < 300;
  return { order, props, dragged };
}

/** После паузы без касаний мигает первая кнопка, ещё через паузу вторая, и по кругу */
function useIdlePulses(pause, d1, d2) {
  const [v, setV] = useState([0, 0]);
  useEffect(() => {
    let raf, tm, alive = true;
    const run = (k, dur, next) => { const t0 = performance.now(); const f = now => {
      if (!alive) return; const x = (now - t0) / dur;
      if (x >= 1) { setV([0, 0]); tm = setTimeout(next, pause); return; }
      setV(k === 0 ? [x, 0] : [0, x]); raf = requestAnimationFrame(f); }; raf = requestAnimationFrame(f); };
    const loop = () => run(0, d1, () => run(1, d2, loop));
    const reset = () => { clearTimeout(tm); cancelAnimationFrame(raf); setV([0, 0]); tm = setTimeout(loop, pause); };
    reset();
    addEventListener('pointerdown', reset, true);
    return () => { alive = false; clearTimeout(tm); cancelAnimationFrame(raf); removeEventListener('pointerdown', reset, true); };
  }, []);
  return v;
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
  const [adding, setAdding] = useState(false);
  const ms = useStore(M.subscribe, M.getState);
  const ts = useStore(T.subscribe, T.getStatus);
  const rubs = S.rubrics(d);
  if (f.rubric !== ALL && f.rubric !== INBOX && !rubs.some(r => r.id === f.rubric)) f.rubric = ALL;
  const q = f.query.trim().toLowerCase();
  const ideas = S.active(d)
    .filter(i => !i.items.some(t => t.tx === 'RECORDING'))
    .filter(i => inRubric(d, i, f.rubric))
    .filter(i => !q || (i.title + ' ' + S.allText(i)).toLowerCase().includes(q))
    .sort((a, b) => b.updated - a.updated);
  const pending = d.ideas.reduce((s, i) => s + i.items.filter(t => t.type === 'VOICE' && t.tx === 'PENDING').length, 0);
  const inbox = S.active(d).filter(i => inRubric(d, i, INBOX)).length;
  const activeRubric = S.rubric(f.rubric, d)?.id || null;
  const ro = useReorder(rubs.map(r => r.id), S.reorderRubrics, false);
  const byId = Object.fromEntries(rubs.map(r => [r.id, r]));
  const [micT, txtT] = useIdlePulses(2000, 1400, 2200);
  const dark = isDark();
  const glow = glowColor(d.settings.glow, dark, true), micGlow = glowColor(d.settings.glow, dark, false);
  // лампа витрины: пара вспышек, ровное свечение, гаснет
  const lamp = txtT <= 0 ? 0 : Math.max(0, Math.min(1, Math.sin(txtT * Math.PI) * (txtT < 0.25 && ((txtT * 24) | 0) % 2 ? 0.35 : 1)));
  const micRot = micT > 0 ? 9 * Math.sin(micT * 6 * Math.PI) * (1 - micT) : 0;
  const micScale = 1 + 0.07 * Math.sin(micT * Math.PI);

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
        <h1 class="h-title two">${titleWrap(d)}</h1>
        <button class="ib" onClick=${() => setInspire(nextPhrase())}><${Icon} n="spark" c="var(--warm)" label="Вдохновение" /></button>
        <button class="ib" onClick=${() => upd({ searching: true })}><${Icon} n="search" label="Поиск" /></button>
        <button class="ib" onClick=${() => nav('/settings')}><${Icon} n="settings" label="Настройки" /></button>`}
    </div>
    <div class="chips">
      <button class=${'chip' + (f.rubric === ALL ? ' on' : '')} onClick=${() => upd({ rubric: ALL })}>Все</button>
      <button class=${'chip' + (f.rubric === INBOX ? ' on' : '')} onClick=${() => upd({ rubric: INBOX })}>${inbox ? 'Входящие · ' + inbox : 'Входящие'}</button>
      ${ro.order.map(id => byId[id]).filter(Boolean).map(r => html`<button key=${r.id} ...${ro.props(r.id)} class=${'chip' + (f.rubric === r.id ? ' on' : '')}
        onClick=${() => !ro.dragged() && upd({ rubric: r.id })}><${Dot} c=${cssColor(r.color)} />${r.name}</button>`)}
      <button class="chip" style="padding:9px 11px" onClick=${() => setAdding(true)}><${Icon} n="add" s=${20} label="Новая рубрика" /></button>
    </div>
    ${banner}
    ${ideas.length === 0 ? html`<div class="empty">${S.active(d).length === 0 ? 'Здесь будут твои мысли.\nНажми на кнопку и скажи первую.' : q ? 'Ничего не нашлось' : 'Тут пока пусто.\nСамое время записать что-нибудь.'}</div>`
      : html`<div class="scroll"><div class="list">${ideas.map(i => html`<${IdeaCard} key=${i.id} d=${d} i=${i} />`)}</div></div>`}
    <div class="bar">
      <button class="round" onClick=${() => newTextIdea(activeRubric)} aria-label="Написать">
        <span class="tt">
          ${lamp > 0 && html`<span class="tt-glow" style=${{ opacity: lamp, color: glow }}><${Icon} n="text" s=${28} /></span>`}
          <span style=${{ color: lamp > 0 ? `color-mix(in srgb, ${glow} ${Math.round(lamp * 100)}%, var(--ink))` : 'var(--ink)' }}><${Icon} n="text" /></span>
        </span>
      </button>
      <button class="mic3d" onClick=${() => startRec(null, activeRubric)} aria-label="Записать мысль">
        <span class="halo" style=${{ background: `radial-gradient(closest-side, color-mix(in srgb, ${micGlow} ${dark ? 34 : 55}%, transparent) 0%, color-mix(in srgb, ${micGlow} ${dark ? 27 : 44}%, transparent) 25%, color-mix(in srgb, ${micGlow} ${dark ? 13 : 21}%, transparent) 50%, color-mix(in srgb, ${micGlow} ${dark ? 4 : 7}%, transparent) 72%, transparent 100%)` }}></span>
        <img src="icons/mic3d.png" alt="" style=${{ transform: `rotate(${micRot}deg) scale(${micScale})` }} />
      </button>
      <span style="width:56px"></span>
    </div>
    ${inspire && html`<${InspireOverlay} key=${inspire} text=${inspire} onNext=${() => setInspire(nextPhrase())} onGone=${() => setInspire(null)} />`}
    ${adding && html`<${Prompt} title="Новая рубрика" placeholder="Название" onClose=${() => setAdding(false)} onOk=${n => upd({ rubric: S.addRubric(n).id })} />`}
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
  let body = i.items.filter(t => t.text.trim() && t.type !== 'LINK').map(t => F.plain(t.text.trim()).replace(/\n/g, ' ')).join(' ');
  if (!i.title.trim()) body = body.replace(title.replace(/…$/, ''), '').trim();
  const tx = i.items.some(t => t.type === 'VOICE' && (t.tx === 'PENDING' || t.tx === 'RUNNING'));
  const cnt = n => i.items.filter(t => t.type === n).length;
  const rc = r ? cssColor(r.color) : null;
  return html`<button class="card idea-card" onClick=${() => nav('/idea/' + i.id)}>
    <div class="meta"><span class="rpill" style=${{ background: rc || 'var(--line)', color: rc ? onColor(rc) : 'var(--ink)' }}>${r ? r.name : 'Входящие'}</span>
      <span class="grow">· ${formatDate(i.created)}</span></div>
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
function ideaParts(d, i) {
  const notes = i.items.filter(t => (t.type === 'TEXT' || t.type === 'VOICE') && t.text.trim()).map(t => '- ' + t.text.trim()).join('\n');
  const links = i.items.filter(t => t.type === 'LINK').map(t => '- ' + t.url + (t.text.trim() ? ` (${t.text.trim()})` : '')).join('\n');
  const imgs = i.items.filter(t => t.type === 'IMAGE').length;
  return { notes, links, imgs };
}
function ideaForAi(d, i, video) {
  const rubric = S.rubric(i.rubricId, d)?.name || 'без рубрики';
  const { notes, links, imgs } = ideaParts(d, i);
  const refs = (links || '(нет)') + (imgs ? `\n(к идее есть картинки-референсы: ${imgs} шт., пришлю отдельно)` : '');
  return (video ? d.settings.aiTemplate : d.settings.aiTemplateIdea).replaceAll('{рубрика}', rubric).replaceAll('{название}', S.displayTitle(i)).replaceAll('{заметки}', notes || '(пока нет)')
    .replaceAll('{ссылки}', refs).replaceAll('{статус}', S.statusLabel(i.status)).replaceAll('{формат}', 'не выбран, предложи подходящий');
}
/** Идея как есть, без запроса: тема, мысль, заметки, ссылки */
function ideaPlain(d, i) {
  const rubric = S.rubric(i.rubricId, d)?.name || 'Входящие';
  const { notes, links, imgs } = ideaParts(d, i);
  let t = `Ниже моя мысль, надиктованная голосом, и заметки к ней. Тема: ${rubric}.\n\nМысль: ${S.displayTitle(i)}\n\nЗаметки:\n${notes || '(пока нет)'}`;
  if (links || imgs) t += '\n\nСсылки и материалы:\n' + (links || '(нет)') + (imgs ? `\n(к идее есть картинки-референсы: ${imgs} шт., пришлю отдельно)` : '');
  return t;
}

function autoGrow(el) { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }

async function shareItem(t) {
  try {
    if (t.file) {
      const b = await S.getFile(t.file);
      const name = (t.type === 'IMAGE' ? 'Референс.jpg' : 'Голосовая.wav');
      const file = new File([b], name, { type: t.type === 'IMAGE' ? 'image/jpeg' : 'audio/wav' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) return await navigator.share({ files: [file] });
    }
    const text = t.type === 'LINK' ? t.url + (t.text ? '\n' + t.text : '') : t.text;
    if (navigator.share) return await navigator.share({ text });
    await copy(text); toast('Скопировано');
  } catch (e) { if (e.name !== 'AbortError') toast('Не получилось отправить'); }
}

function TitleField({ i }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(i.title);
  const ref = useRef();
  useEffect(() => { if (edit) { ref.current?.focus(); setTimeout(() => autoGrow(ref.current), 0); } }, [edit]);
  const save = () => { S.updateIdea(i.id, x => ({ ...x, title: v.trim() })); setEdit(false); };
  if (edit) return html`<div style="display:flex;gap:8px;align-items:center">
    <textarea class="title-in" rows="1" ref=${ref} placeholder="Название" value=${v} enterkeyhint="done"
      onInput=${e => { setV(e.target.value.replace(/\n/g, '')); autoGrow(e.target); }} onKeyDown=${e => e.key === 'Enter' && (e.preventDefault(), save())} />
    <button class="okbtn" onClick=${e => { e.stopPropagation(); save(); }}><${Icon} n="check" label="Сохранить название" /></button></div>`;
  if (!i.title.trim()) return html`<button class="tbtn" style="align-self:flex-start;padding:6px 2px;display:flex;gap:6px;align-items:center;font-size:17px"
    onClick=${() => { setV(''); setEdit(true); }}><${Icon} n="add" s=${20} />Добавить название</button>`;
  return html`<div class="title-in" onClick=${() => { setV(i.title); setEdit(true); }}>${i.title}</div>`;
}

function IdeaScreen({ d, id }) {
  const i = S.idea(id, d);
  const [editing, setEditing] = useState(() => { const e = editOnOpen; editOnOpen = null; return e; });
  const [menu, setMenu] = useState(false);
  const [aiMenu, setAiMenu] = useState(false);
  const [rubMenu, setRubMenu] = useState(false);
  const [merging, setMerging] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [ask, setAsk] = useState(null);
  const [viewer, setViewer] = useState(null);
  const fileRef = useRef();

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
  const trash = () => { S.trashIdea(id); toast('Идея в «Архиве»'); back(); };
  const ai = async video => { await copy(ideaForAi(S.get(), S.idea(id), video)); toast('Скопировано. Вставь в ChatGPT, Claude или другую нейросеть'); };
  const openItems = i.items.filter(t => !t.done), doneItems = i.items.filter(t => t.done);
  const card = t => html`<${ItemCard} key=${t.id} i=${i} t=${t} editing=${editing === t.id} setEditing=${setEditing} setAsk=${setAsk} onTrash=${trash} onImage=${setViewer} />`;

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

  return html`<div class="sheet-wrap"><div class="sheet-scrim" onClick=${back}></div><div class="sheet">
    <div class="grab"></div>
    <div class="top" style="padding:4px 8px;position:relative;min-height:0">
      <button class="backc" onClick=${back}><${Icon} n="back" label="Назад" /></button>
      <span style="flex:1"></span>
      <button class="aibtn" onClick=${() => setAiMenu(true)}><${Icon} n="spark" s=${18} />В нейросеть</button>
      ${aiMenu && html`<${Menu} style="right:52px" onClose=${() => setAiMenu(false)} items=${[
        ['copy', 'Просто скопировать', async () => { await copy(ideaPlain(S.get(), S.idea(id))); toast('Скопировано. Вставь в нейросеть и допиши свою задачу'); }, 'тема, мысль, заметки, без запроса'],
        ['bulb', 'Разобрать мысль', () => ai(false), 'суть, пробелы, следующие шаги'],
        ['video', 'Сценарий для видео', () => ai(true), 'хуки, структура, подпись']]} />`}
      <button class="ib" onClick=${() => setMenu(true)}><${Icon} n="more" label="Ещё" /></button>
      ${menu && html`<${Menu} onClose=${() => setMenu(false)} items=${[
        ['merge', 'Перенести в другую идею', () => setMerging(true)],
        ['del', 'Удалить идею', () => setAsk({ title: 'Удалить идею?', text: 'Идея уйдёт в «Архив» вместе с голосовыми и картинками. Вернуть её можно в настройках.', ok: trash })]]} />`}
    </div>
    <div class="scroll"><div class="pad" style="padding:0 20px 24px;display:flex;flex-direction:column;gap:12px">
      <${TitleField} key=${id} i=${i} />
      <div style="display:flex;align-items:center;gap:10px;position:relative">
        <button class="chip" onClick=${() => setRubMenu(true)}><${Dot} c=${r ? cssColor(r.color) : 'var(--muted)'} />${r ? r.name : 'Входящие'}</button>
        <span class="lbl">${formatDate(i.created)}</span>
        ${rubMenu && html`<div class="scrim" onClick=${() => setRubMenu(false)}></div><div class="menu" style="left:0;right:auto;top:46px">
          <button onClick=${() => { setRubMenu(false); S.updateIdea(id, x => ({ ...x, rubricId: null })); }}><${Dot} c="var(--muted)" />Входящие</button>
          ${S.rubrics(d).map(rr => html`<button onClick=${() => { setRubMenu(false); S.updateIdea(id, x => ({ ...x, rubricId: rr.id })); }}><${Dot} c=${cssColor(rr.color)} />${rr.name}</button>`)}</div>`}
      </div>
      <div class="chips" style="padding:0">${S.STATUSES.map(([k]) => html`<${Pill} s=${k} filled=${i.status === k} onClick=${() => {
        if (i.status === k) return;
        S.updateIdea(id, x => ({ ...x, status: k }));
        if (k === 'DONE') { toast('Идея закрыта и ушла в архив'); back(); }
      }} />`)}</div>
      ${openItems.map(card)}
      ${doneItems.length > 0 && html`<button class="done-head" onClick=${() => setShowDone(!showDone)}>
        <${Icon} n="checkCircle" s=${20} c="var(--muted)" /><span style="flex:1;text-align:left">Выполнено · ${doneItems.length}</span>
        <span style=${{ transform: showDone ? 'rotate(180deg)' : null }}><${Icon} n="expand" c="var(--muted)" /></span></button>`}
      ${showDone && doneItems.map(t => html`<div style="opacity:.5">${card(t)}</div>`)}
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
    ${merging && html`<${MergeDialog} d=${d} from=${i} onClose=${() => setMerging(false)} onPick=${dst => {
      S.mergeInto(id, dst.id); history.replaceState(null, '', '#/idea/' + dst.id); dispatchEvent(new HashChangeEvent('hashchange'));
      toast('Перенесено в «' + S.displayTitle(dst).slice(0, 40) + '»'); }} />`}
    ${viewer && html`<div class="overlay" style="background:#000;padding:0;justify-content:flex-start" onClick=${() => { URL.revokeObjectURL(viewer.url); setViewer(null); }}>
      <img src=${viewer.url} style="flex:1;min-height:0;max-width:100%;object-fit:contain" />
      <button class="sendbtn" onClick=${e => { e.stopPropagation(); shareItem(viewer.t); }}><${Icon} n="share" s=${20} />Отправить</button></div>`}
  </div></div>`;
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
    ? setAsk({ title: 'Удалить идею?', text: 'Это единственная запись в идее. Идея уйдёт в «Архив», вернуть её можно в настройках.', ok: onTrash })
    : setAsk({ title: 'Удалить?', text: t.type === 'VOICE' ? 'Голосовая запись и её текст удалятся.' : t.type === 'IMAGE' ? 'Картинка удалится из идеи.' : 'Заметка удалится.', ok: () => S.removeItem(i.id, t.id) });
  const items = [];
  if (t.type === 'VOICE' && (t.tx === 'DONE' || t.tx === 'ERROR')) items.push(['refresh', 'Расшифровать заново', () => T.retry(i.id, t.id)]);
  if (t.text.trim()) items.push(['copy', 'Копировать текст', async () => { await copy(t.text.trim()); toast('Текст скопирован'); }]);
  if (t.type !== 'TEXT' || t.text.trim()) items.push(['share', 'Отправить', () => shareItem(t)]);
  items.push(t.done ? ['replay', 'Вернуть в работу', () => S.updateItem(i.id, t.id, x => ({ ...x, done: false }))]
    : ['checkCircle', 'Выполнено', () => { S.updateItem(i.id, t.id, x => ({ ...x, done: true })); toast('Улетело в «Выполнено» внизу идеи'); }, null, '#3DBE7A']);
  items.push(['del', 'Удалить', del]);
  const label = { TEXT: 'Заметка', IMAGE: 'Референс', LINK: 'Ссылка' }[t.type];

  let body;
  if (t.type === 'VOICE') {
    if (['PENDING', 'RUNNING', 'RECORDING'].includes(t.tx)) body = html`<div style="margin-top:8px"><div class="lbl" style="font-size:15px;font-weight:600">${t.tx === 'RUNNING' ? 'Расшифровываю…' : t.tx === 'RECORDING' ? 'Идёт запись…' : 'Расшифровка в очереди'}</div><${LingerPhrase} k=${t.id} active=${true} /></div>`;
    else if (t.tx === 'ERROR') body = html`<div style="margin-top:8px;display:flex;align-items:center;gap:8px"><span class="muted" style="flex:1">${typo('Не получилось расшифровать. Аудио сохранено.')}</span><button class="tbtn" onClick=${() => T.retry(i.id, t.id)}>Повторить</button></div>`;
    else body = html`<${EditText} i=${i} t=${t} editing=${editing} setEditing=${setEditing} hint="Слов не разобрать. Можно дописать текстом." /><${LingerPhrase} k=${t.id} active=${false} />`;
  } else if (t.type === 'TEXT') body = html`<${EditText} i=${i} t=${t} editing=${editing} setEditing=${setEditing} hint="Напиши мысль" />`;
  else if (t.type === 'IMAGE') body = img && html`<img class="ref" src=${img} onClick=${async () => { const b = await S.getFile(t.file); b && onImage({ url: URL.createObjectURL(b), t }); }} />`;
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

/** Текст с разметкой: жирный, зачёркнутый, маркер, ссылки, списки и чек-листы с нажимаемыми галочками */
function RichText({ text, onToggle }) {
  const lineHtml = body => F.spans(body).map(sp => {
    const st = { fontWeight: sp.bold ? 700 : null, textDecoration: sp.strike ? 'line-through' : null, background: sp.mark ? 'color-mix(in srgb, var(--warm) 42%, transparent)' : null, borderRadius: sp.mark ? '3px' : null };
    return html`<span style=${st}>${splitLinks(sp.text).map(p => p.url ? html`<a href=${p.url} target="_blank" rel="noopener" onClick=${e => e.stopPropagation()}>${p.t}</a>` : p.t)}</span>`;
  });
  return html`<div class="rich">${text.split('\n').map((raw, n) => {
    if (!raw.trim()) return html`<div style="height:8px"></div>`;
    const ln = F.line(raw);
    if (ln.kind === 'BULLET') return html`<div class="rl"><span class="bul">•</span><span>${lineHtml(ln.body)}</span></div>`;
    if (ln.kind === 'TODO' || ln.kind === 'DONE') { const done = ln.kind === 'DONE';
      return html`<div class="rl"><button class="cb" onClick=${e => { e.stopPropagation(); onToggle && onToggle(n); }}>
        <${Icon} n=${done ? 'boxOn' : 'box'} s=${22} c=${done ? 'var(--accent)' : 'var(--muted)'} label=${done ? 'Снять галочку' : 'Отметить'} /></button>
        <span style=${done ? { textDecoration: 'line-through', color: 'var(--muted)' } : null}>${lineHtml(ln.body)}</span></div>`; }
    return html`<div>${lineHtml(ln.body)}</div>`;
  })}</div>`;
}

function EditText({ i, t, editing, setEditing, hint }) {
  const [v, setV] = useState(t.text);
  const ref = useRef();
  const vRef = useRef(v); vRef.current = v;
  useEffect(() => { if (editing) { setV(t.text); setTimeout(() => { if (ref.current) { autoGrow(ref.current); ref.current.focus(); } }, 30); } }, [editing]);
  const save = (x = vRef.current) => { if (x !== t.text) S.updateItem(i.id, t.id, y => ({ ...y, text: x })); };
  // правка сразу в поле, чтобы следующие буквы не потерялись
  const apply = e => { const el = ref.current; vRef.current = e.text; if (el) { el.value = e.text; autoGrow(el); el.focus(); el.setSelectionRange(e.start, e.end); } setV(e.text); };
  const sel = () => { const el = ref.current; return [el.selectionStart, el.selectionEnd]; };
  if (editing) return html`<div style="margin-top:8px">
    <textarea ref=${ref} class="edit" rows="2" placeholder=${hint} value=${v}
      onInput=${e => { const el = e.target; const c = el.selectionStart === el.selectionEnd ? F.continueList(vRef.current, el.value, el.selectionStart) : null;
        if (c) apply(c); else { vRef.current = el.value; setV(el.value); autoGrow(el); } setTimeout(() => el.scrollIntoView({ block: 'nearest' }), 0); }}
      onBlur=${() => save()} />
    <div class="fbar">
      <button onMouseDown=${e => e.preventDefault()} onClick=${() => { const [a, b] = sel(); apply(F.prefixLines(vRef.current, a, b, F.TODO)); }}><${Icon} n="checklist" label="Чек-лист" /></button>
      <button onMouseDown=${e => e.preventDefault()} onClick=${() => { const [a, b] = sel(); apply(F.prefixLines(vRef.current, a, b, F.BULLET)); }}><${Icon} n="bullets" label="Список" /></button>
      <button onMouseDown=${e => e.preventDefault()} onClick=${() => { const [a, b] = sel(); apply(F.wrap(vRef.current, a, b, '**')); }}><${Icon} n="bold" label="Жирный" /></button>
      <button onMouseDown=${e => e.preventDefault()} onClick=${() => { const [a, b] = sel(); apply(F.wrap(vRef.current, a, b, '~~')); }}><${Icon} n="strike" label="Зачеркнуть" /></button>
      <span style="flex:1"></span>
      <button class="okbtn" onMouseDown=${e => e.preventDefault()} onClick=${e => { e.stopPropagation(); save(); setEditing(null); }}><${Icon} n="check" label="Готово" /></button>
    </div></div>`;
  return html`<div style="margin-top:8px" onClick=${() => setEditing(t.id)}>${t.text.trim()
    ? html`<${RichText} text=${t.text} onToggle=${n => S.updateItem(i.id, t.id, x => ({ ...x, text: F.toggleTodo(x.text, n) }))} />`
    : html`<div class="txt muted">${hint}</div>`}</div>`;
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
  const [merging, setMerging] = useState(false);
  const [title, setTitle] = useState(i?.title || '');
  if (!i) { onDone(); return null; }
  const pick = rid => { S.updateIdea(id, x => ({ ...x, rubricId: rid })); onDone(); };
  return html`<div class="screen" style="z-index:33"><div class="scroll" style="padding:24px">
    <h2 class="h-big" style="margin-top:24px">Сохранено</h2>
    ${d.settings.phrases && html`<div style="margin-top:12px"><${Phrase} text=${phrase} big /></div>`}
    <input class="field" style="margin-top:28px;background:var(--card)" placeholder="Название, если хочешь" value=${title}
      onInput=${e => { setTitle(e.target.value); S.updateIdea(id, x => ({ ...x, title: e.target.value })); }} />
    <div class="lbl" style="font-size:17px;font-weight:600;margin:24px 0 14px">Куда отнести?</div>
    <div class="rub-grid">${S.rubrics(d).map(r => { const c = cssColor(r.color); const sel = i.rubricId === r.id;
      return html`<button class="rub" style=${{ background: sel ? c : `color-mix(in srgb, ${c} 18%, transparent)`, color: sel ? '#1B1830' : 'var(--ink)' }} onClick=${() => pick(r.id)}>${r.name}</button>`; })}
      <button class="rub" style="background:var(--card);height:60px;text-align:center;font-size:15px" onClick=${() => pick(null)}>Во входящие</button>
      <button class="rub" style="height:60px;font-size:15px;display:flex;align-items:center;justify-content:center;gap:4px;white-space:nowrap" onClick=${() => setAdding(true)}><${Icon} n="add" s=${22} />Добавить рубрику</button>
    </div>
    ${S.active(d).some(x => x.id !== id) && html`<div style="text-align:center;margin-top:24px"><button class="tbtn" style="color:var(--ink)" onClick=${() => setMerging(true)}>Добавить к другой идее</button></div>`}
    <div style="text-align:center;margin-top:4px"><button class="tbtn muted" onClick=${() => { S.trashIdea(id); onDone(); toast('Запись удалена. Если передумаешь, она в «Архиве»'); }}>Отменить запись</button></div>
  </div>
  ${adding && html`<${Prompt} title="Новая рубрика" placeholder="Название" onClose=${() => setAdding(false)} onOk=${n => pick(S.addRubric(n).id)} />`}
  ${merging && html`<${MergeDialog} d=${d} from=${i} onClose=${() => setMerging(false)} onPick=${dst => { S.mergeInto(id, dst.id); toast('Добавлено в «' + S.displayTitle(dst).slice(0, 40) + '»'); onDone(); }} />`}
  </div>`;
}

// ---------- архив ----------
function Trash({ d }) {
  const [ask, setAsk] = useState(null);
  const closed = S.closed(d), list = S.trash(d), rubs = S.archivedRubrics(d);
  const empty = !closed.length && !list.length && !rubs.length;
  return html`<div class="screen">
    <div class="top" style="padding-left:4px"><button class="ib" style="color:var(--ink)" onClick=${back}><${Icon} n="back" label="Назад" /></button>
      <h1 class="h-title">Архив</h1>${!empty && html`<button class="tbtn" onClick=${() => setAsk({ title: 'Очистить архив?', text: 'Закрытые и удалённые идеи и рубрики из архива сотрутся насовсем вместе с голосовыми и картинками.', ok: S.emptyTrash })}>Очистить</button>`}</div>
    <div class="scroll">${empty ? html`<div class="empty" style="margin-top:80px">Здесь пусто</div>` : html`<div class="list" style="padding-bottom:40px">
      ${closed.length > 0 && html`<div class="lbl" style="margin:6px 4px 0">Закрытые идеи</div>`}
      ${closed.map(i => html`<div class="card"><div class="lbl">Закрыта ${formatDate(i.updated)}</div><div class="t2" onClick=${() => nav('/idea/' + i.id)}>${S.displayTitle(i)}</div>
        <div style="display:flex;gap:8px;margin-top:10px"><button class="actbtn primary" onClick=${() => { S.restoreIdea(i.id); toast('Идея снова в работе'); }}>Вернуть в работу</button>
        <button class="actbtn" onClick=${() => setAsk({ title: 'Стереть насовсем?', text: 'Идея и её файлы удалятся без возможности вернуть.', ok: () => S.deleteIdea(i.id) })}>Стереть</button></div></div>`)}
      ${rubs.length > 0 && html`<div class="lbl" style="margin:10px 4px 0">Рубрики</div>`}
      ${rubs.map(r => html`<div class="card"><div class="meta"><${Dot} c=${cssColor(r.color)} />Удалена ${formatDate(r.deletedAt)} · ${plural(S.countIn(d, r.id), 'идея', 'идеи', 'идей')}</div><div class="t2">${r.name}</div>
        <div style="display:flex;gap:8px;margin-top:10px"><button class="actbtn primary" onClick=${() => { S.restoreRubric(r.id); toast('Рубрика вернулась'); }}>Вернуть</button>
        <button class="actbtn" onClick=${() => setAsk({ title: 'Стереть рубрику?', text: 'Рубрика и все её идеи удалятся без возможности вернуть.', ok: () => S.eraseRubric(r.id) })}>Стереть</button></div></div>`)}
      ${list.length > 0 && html`<div class="lbl" style="margin:10px 4px 0">Удалённые идеи</div>`}
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
      <${Fold} title="Тема и подпись">
        <div class="lbl">Подсветка кнопок записи и текста</div>
        <div class="chips" style="padding:0;flex-wrap:wrap">${GLOWS.map(([k, l]) => html`<button class=${'chip' + (s.glow === k ? ' on' : '')} style="font-size:14px;padding:8px 12px" onClick=${() => set({ glow: k })}>
          <span class="dot" style=${{ width: '14px', height: '14px', background: `linear-gradient(90deg, ${glowColor(k, isDark(), false)}, ${glowColor(k, isDark(), true)})` }}></span>${l}</button>`)}</div>
        <div class="small muted">${typo('Авто: микрофон тёплый жёлтый, «Тт» жёлтый в тёмной теме и сиреневый в светлой.')}</div>
        <div class="lbl">Тема</div>
        ${[['system', 'Как в телефоне'], ['dark', 'Тёмная'], ['light', 'Светлая']].map(([k, l]) => html`<button class=${'opt' + (s.theme === k ? ' on' : '')} onClick=${() => set({ theme: k })}><span class="radio"></span>${l}</button>`)}
        <div class="lbl">Подпись на главном</div>
        <input class="field" placeholder="Например, Кристи" value=${s.name} maxlength="30" onInput=${e => set({ name: e.target.value })} />
        <div class="small muted">Будет: ${titleOf(d)}</div>
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
      <${Fold} title="Запись">
        <${Switch} label="Фразы во время расшифровки" on=${s.phrases} onClick=${() => set({ phrases: !s.phrases })} />
      <//>
      <${Fold} title="Запросы для нейросети">
        <div class="small muted">${typo('Кнопка «В нейросеть» в идее копирует один из этих запросов вместе с идеей. Вместо {рубрика}, {название}, {заметки}, {ссылки}, {статус} подставится идея.')}</div>
        <div class="lbl">Разобрать мысль</div>
        <textarea class="field" style="min-height:200px;font-size:14px" value=${s.aiTemplateIdea} onInput=${e => set({ aiTemplateIdea: e.target.value })} />
        <button class="actbtn" onClick=${() => set({ aiTemplateIdea: DEFAULT_AI_TEMPLATE_IDEA })}>Вернуть стандартный</button>
        <div class="lbl">Сценарий для видео</div>
        <textarea class="field" style="min-height:200px;font-size:14px" value=${s.aiTemplate} onInput=${e => set({ aiTemplate: e.target.value })} />
        <button class="actbtn" onClick=${() => set({ aiTemplate: DEFAULT_AI_TEMPLATE })}>Вернуть стандартный</button>
      <//>
      <${Fold} title="Архив">
        <div class="small muted">${(() => { const c = S.closed(d).length, t = S.trash(d).length, r = S.archivedRubrics(d).length;
          return c + t + r ? [c && 'закрытых: ' + c, t && 'удалённых: ' + t, r && 'рубрик: ' + r].filter(Boolean).join(', ') : 'Пусто'; })()}</div>
        <button class="actbtn" onClick=${() => nav('/trash')}>Открыть «Архив»</button>
      <//>
      <${Fold} title="Резервная копия">
        <div class="small muted">${typo('Все идеи, голосовые и картинки одним файлом. Его можно отправить себе в Телеграм или Макс, а потом загрузить на этом или другом телефоне, в том числе на Android.')}</div>
        <button class="actbtn primary" onClick=${shareBackup}>Отправить копию</button>
        <button class="actbtn" onClick=${() => importRef.current.click()}>Загрузить из копии</button>
        <input ref=${importRef} type="file" accept=".zip,application/zip" hidden onChange=${e => { const f = e.target.files[0]; e.target.value = ''; f && setAsk({ title: 'Загрузить копию?', text: 'Все текущие идеи заменятся содержимым копии.', okText: 'Загрузить', ok: () => importBackup(f) }); }} />
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
  const rubs = S.rubrics(d);
  const ro = useReorder(rubs.map(r => r.id), S.reorderRubrics, true);
  const byId = Object.fromEntries(rubs.map(r => [r.id, r]));
  return html`<div class="small muted">${typo('Зажми рубрику и веди пальцем, чтобы поменять порядок.')}</div>
    ${ro.order.map(id => byId[id]).filter(Boolean).map(r => html`<div class="row-set rub-row" key=${r.id} ...${ro.props(r.id)}>
      <${Icon} n="drag" s=${20} c="var(--muted)" /><${Dot} c=${cssColor(r.color)} s=${12} /><span class="grow marq" onClick=${() => !ro.dragged() && setEdit(r)}><span>${r.name}</span></span>
      <button class="ib" style="width:36px;height:36px" onClick=${() => setEdit(r)}><${Icon} n="edit" s=${18} label="Переименовать" /></button>
      <button class="ib" style="width:36px;height:36px" onClick=${() => setAsk({ title: 'Удалить рубрику?', text: 'Рубрика и её идеи уйдут в «Архив». Вернуть можно оттуда.', ok: () => S.archiveRubric(r.id) })}><${Icon} n="del" s=${18} label="Удалить" /></button></div>`)}
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
  else if (route.startsWith('/idea/')) screen = html`<${Home} d=${d} /><${IdeaScreen} key=${route} d=${d} id=${route.slice(6)} />`;
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
