// Лёгкая разметка заметок, совместимая с Markdown и с Android-версией:
// **жирный**, ~~зачёркнутый~~, ==маркер==, строки «- » (список) и «[ ] » / «[x] » (чек-лист).
export const BULLET = '- ', TODO = '[ ] ', DONE = '[x] ';

export function line(s) {
  if (s.startsWith(TODO)) return { kind: 'TODO', body: s.slice(4) };
  if (s.startsWith(DONE) || s.startsWith('[X] ')) return { kind: 'DONE', body: s.slice(4) };
  if (s.startsWith(BULLET) || s.startsWith('• ')) return { kind: 'BULLET', body: s.slice(2) };
  return { kind: 'TEXT', body: s };
}

const MARKERS = ['**', '~~', '=='];
/** Строка на куски со стилями; незакрытый маркер остаётся текстом */
export function spans(s) {
  const out = []; let bold = false, strike = false, mark = false, buf = '';
  const flush = () => { if (buf) { out.push({ text: buf, bold, strike, mark }); buf = ''; } };
  for (let i = 0; i < s.length;) {
    const m = MARKERS.find(x => s.startsWith(x, i));
    const open = m === '**' ? bold : m === '~~' ? strike : m === '==' ? mark : false;
    if (m && (open || s.indexOf(m, i + 2) > i + 2)) {
      flush();
      if (m === '**') bold = !bold; else if (m === '~~') strike = !strike; else mark = !mark;
      i += 2;
    } else { buf += s[i]; i++; }
  }
  flush();
  return out;
}

/** Без разметки: для заголовков, превью и поиска */
export const plain = text => text.split('\n').map(l => {
  const ln = line(l);
  return ({ BULLET: '• ', TODO: '☐ ', DONE: '☑ ', TEXT: '' })[ln.kind] + spans(ln.body).map(x => x.text).join('');
}).join('\n');

export function toggleTodo(text, n) {
  const ls = text.split('\n'); const l = ls[n];
  if (l === undefined) return text;
  if (l.startsWith(TODO)) ls[n] = DONE + l.slice(4);
  else if (l.startsWith(DONE) || l.startsWith('[X] ')) ls[n] = TODO + l.slice(4);
  return ls.join('\n');
}

/** Обернуть выделение маркером или снять, если уже обёрнуто */
export function wrap(text, start, end, m) {
  const a = Math.min(start, end), b = Math.max(start, end);
  if (a >= m.length && b + m.length <= text.length && text.slice(a - m.length, a) === m && text.slice(b, b + m.length) === m)
    return { text: text.slice(0, a - m.length) + text.slice(a, b) + text.slice(b + m.length), start: a - m.length, end: b - m.length };
  return { text: text.slice(0, a) + m + text.slice(a, b) + m + text.slice(b), start: a + m.length, end: b + m.length };
}

/** Строки выделения в список или чек-лист; повторное нажатие убирает */
export function prefixLines(text, start, end, prefix) {
  const a = Math.min(start, end), b = Math.max(start, end);
  const ls = a === 0 ? 0 : text.lastIndexOf('\n', a - 1) + 1;
  let le = text.indexOf('\n', b); if (le < 0) le = text.length;
  const block = text.slice(ls, le).split('\n');
  const all = block.every(l => l.startsWith(prefix) || (prefix === TODO && l.startsWith(DONE)));
  let delta0 = 0;
  const changed = block.map((l, i) => {
    const stripped = l.startsWith(TODO) || l.startsWith(DONE) ? l.slice(4) : l.startsWith(BULLET) ? l.slice(2) : l;
    const res = all ? stripped : prefix + stripped;
    if (i === 0) delta0 = res.length - l.length;
    return res;
  }).join('\n');
  const t = text.slice(0, ls) + changed + text.slice(le);
  const d = changed.length - (le - ls);
  const clamp = x => Math.max(ls, Math.min(t.length, x));
  return { text: t, start: clamp(a + delta0), end: clamp(b + d) };
}

/** Enter в пункте списка продолжает список, Enter в пустом пункте его заканчивает */
export function continueList(old, nw, cursor) {
  if (nw.length !== old.length + 1 || cursor < 1 || nw[cursor - 1] !== '\n') return null;
  const ps = nw.lastIndexOf('\n', cursor - 2) + 1;
  const prev = nw.slice(ps, cursor - 1);
  const prefix = prev.startsWith(TODO) || prev.startsWith(DONE) ? TODO : prev.startsWith(BULLET) ? BULLET : null;
  if (!prefix) return null;
  const body = prefix === TODO ? prev.slice(4) : prev.slice(2);
  if (!body.trim()) { const t = nw.slice(0, ps) + nw.slice(cursor); return { text: t, start: ps, end: ps }; }
  const t = nw.slice(0, cursor) + prefix + nw.slice(cursor);
  return { text: t, start: cursor + prefix.length, end: cursor + prefix.length };
}
