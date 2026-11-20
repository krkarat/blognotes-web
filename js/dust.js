// Фраза-вдохновение: появляется плавно, касание по фразе берёт другую,
// касание по фону: буквы слева направо рассыпаются мелкой сверкающей пылью, и она дымкой уходит вверх.
import { html, useEffect, useRef, useState } from './vendor/preact-htm.js';
import { Icon } from './icons.js';
import { typo } from './texts.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const DUR = 2800;

function starPath(ctx, x, y, r) {
  const inner = r * 0.22;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 4 * i - Math.PI / 2, rr = i % 2 ? inner : r;
    const px = x + rr * Math.cos(a), py = y + rr * Math.sin(a);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
}

export function InspireOverlay({ text, onNext, onGone }) {
  const wrap = useRef(), phrase = useRef(), canvas = useRef();
  const [going, setGoing] = useState(false);
  const [size, setSize] = useState(22);

  // короткая фраза в две строки (шрифт меньше максимум на 3 px), длинная остаётся крупной в три
  useEffect(() => {
    const el = phrase.current; if (!el) return;
    const lines = px => { el.style.fontSize = px + 'px'; el.style.lineHeight = Math.round(px * 1.3) + 'px'; return Math.round(el.scrollHeight / Math.round(px * 1.3)); };
    let pick = 22;
    for (let k = 0; k <= 3; k++) if (lines(22 - k) <= 2) { pick = 22 - k; break; }
    lines(pick); setSize(pick);
  }, [text]);

  function dissolve(e) {
    if (going || (phrase.current && phrase.current.contains(e.target))) return;
    setGoing(true);
    const cv = canvas.current, box = wrap.current.getBoundingClientRect();
    const dpr = Math.min(3, devicePixelRatio || 1);
    cv.width = box.width * dpr; cv.height = box.height * dpr;
    const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
    const dark = getComputedStyle(document.documentElement).colorScheme !== 'light';
    const colors = dark ? ['#F2F8FF', '#CFE6FF', '#A9D2FF', '#FFFFFF', '#DDEBFF', '#FFE6B0']
      : ['#3D7FD9', '#5B9BEB', '#2F6BC4', '#7C9BE6', '#8A7BE0', '#D9962B'];
    const chars = [...phrase.current.querySelectorAll('.ch')];
    const pr = phrase.current.getBoundingClientRect();
    const tops = [...new Set(chars.map(c => Math.round(c.getBoundingClientRect().top)))].sort((a, b) => a - b);
    const per = Math.max(14, Math.min(40, Math.round(2600 / Math.max(1, chars.length))));
    const motes = [], at = [];
    chars.forEach((c, i) => {
      const r = c.getBoundingClientRect();
      const line = tops.indexOf(Math.round(r.top));
      at[i] = ((r.left + r.width / 2 - pr.left) / Math.max(1, pr.width)) * 0.42 + line / Math.max(1, tops.length) * 0.14;
      if (!c.textContent.trim()) return;
      for (let k = 0; k < per; k++) {
        const big = Math.random() < 0.025;
        motes.push({
          x: r.left - box.left + Math.random() * r.width, y: r.top - box.top + r.height * (0.15 + Math.random() * 0.75),
          rel: at[i] + Math.random() * 0.07, life: 0.34 + Math.random() * 0.1,
          rise: box.height * (0.12 + Math.random() * 0.3), drift: (Math.random() - 0.3) * 60, swirl: 6 + Math.random() * 22,
          freq: 3 + Math.random() * 5, phase: Math.random() * 6.28,
          r: big ? 1.6 + Math.random() * 1.4 : 0.35 + Math.random() * 0.75,
          c: colors[(Math.random() * colors.length) | 0], tw: 8 + Math.random() * 14, star: big,
        });
      }
    });
    const side = [...wrap.current.querySelectorAll('.side')];
    const t0 = performance.now();
    const frame = now => {
      const v = Math.min(1, (now - t0) / DUR);
      chars.forEach((c, i) => { c.style.opacity = 1 - smooth(at[i], at[i] + 0.12, v); });
      side.forEach(s => { s.style.opacity = 1 - smooth(0, 0.25, v); });
      wrap.current.style.background = `color-mix(in srgb, var(--bg) ${Math.round(92 * (1 - smooth(0.45, 1, v)))}%, transparent)`;
      ctx.clearRect(0, 0, box.width, box.height);
      for (const m of motes) {
        const lt = (v - m.rel) / m.life;
        if (lt <= 0 || lt >= 1) continue;
        const e = 1 - (1 - lt) * (1 - lt); // сорвалась резко, к концу тормозит, как дым
        const px = m.x + m.drift * e + Math.sin(m.phase + lt * m.freq) * m.swirl * lt;
        const py = m.y - m.rise * e;
        const s = Math.sin((v * m.tw + m.phase) * 2 * Math.PI);
        const a = Math.max(0, Math.min(1, (lt < 0.08 ? lt / 0.08 : 1) * (1 - lt) * (1 - lt) * (0.45 + 0.55 * s * s)));
        const rad = m.r * (1 - lt * 0.4);
        ctx.globalAlpha = a; ctx.fillStyle = m.c;
        if (m.star) {
          const g = ctx.createRadialGradient(px, py, 0, px, py, rad * 4);
          g.addColorStop(0, m.c); g.addColorStop(1, 'transparent');
          ctx.globalAlpha = a * 0.45; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, rad * 4, 0, 7); ctx.fill();
          ctx.globalAlpha = a; ctx.fillStyle = m.c; starPath(ctx, px, py, rad * 2.4); ctx.fill();
        } else { ctx.beginPath(); ctx.arc(px, py, rad, 0, 7); ctx.fill(); }
      }
      if (v < 1) requestAnimationFrame(frame); else onGone();
    };
    requestAnimationFrame(frame);
  }

  return html`<div class="overlay inspire-ov" ref=${wrap} onClick=${dissolve}>
    <span class="side"><${Icon} n="spark" s=${40} c="var(--warm)" /></span>
    <div class="inspire" ref=${phrase} style=${{ fontSize: size + 'px', marginTop: '20px' }}
      onClick=${e => { if (!going) { e.stopPropagation(); onNext(); } }}>${[...text].map(ch => html`<span class="ch">${ch}</span>`)}</div>
    <div class="small muted side" style="margin-top:28px">${typo('Коснись фразы, чтобы взять другую')}</div>
    <canvas ref=${canvas} style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none"></canvas>
  </div>`;
}
