// Запись голоса. Звук сразу переводится в 16 кГц моно (то, что нужно Whisper)
// и каждую секунду сохраняется в память телефона. Если экран заблокируют или
// приложение закроется, всё, что успели сказать, останется и уйдёт в расшифровку.
import * as idb from './idb.js';

export const RATE = 16000;

export function wavHeader(samples) {
  const b = new ArrayBuffer(44), v = new DataView(b);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples * 2, true);
  return b;
}

/** WAV (16 бит) → Float32 16 кГц моно. Понимает и файлы из Android-версии */
export async function wavToFloat(blob) {
  const buf = await blob.arrayBuffer();
  const v = new DataView(buf);
  let off = 12, rate = RATE, ch = 1, bits = 16, dataOff = 44, dataLen = buf.byteLength - 44;
  while (off + 8 <= buf.byteLength) {
    const id = String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
    const len = v.getUint32(off + 4, true);
    if (id === 'fmt ') { ch = v.getUint16(off + 10, true); rate = v.getUint32(off + 12, true); bits = v.getUint16(off + 22, true); }
    if (id === 'data') { dataOff = off + 8; dataLen = Math.min(len || buf.byteLength, buf.byteLength - dataOff); break; }
    off += 8 + len + (len & 1);
  }
  if (bits !== 16) throw new Error('Неподдерживаемый WAV');
  const n = Math.floor(dataLen / 2 / ch);
  let out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += v.getInt16(dataOff + (i * ch + c) * 2, true);
    out[i] = s / ch / 32768;
  }
  if (rate !== RATE) out = resample(out, rate, RATE);
  return out;
}

function resample(x, from, to) {
  const n = Math.floor(x.length * to / from), out = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) {
    const a = i * r, j = Math.floor(a), f = a - j;
    out[i] = (x[j] || 0) * (1 - f) + (x[j + 1] || 0) * f;
  }
  return out;
}

/** Склеивает сохранённые куски записи в WAV. Возвращает {blob, ms} или null, если звука нет */
export async function assemble(rec) {
  const parts = await idb.chunksOf(rec);
  const samples = parts.reduce((s, p) => s + p.byteLength / 2, 0);
  if (samples < RATE / 4) return null;
  return { blob: new Blob([wavHeader(samples), ...parts], { type: 'audio/wav' }), ms: Math.round(samples / RATE * 1000) };
}

/**
 * Одна активная запись. onLevel получает громкость 0..1 для анимации.
 * Важно: start() вызывать прямо из обработчика нажатия, иначе iOS не даст включить звук.
 */
export class Recorder {
  constructor() { this.active = null; }

  async start(rec, onLevel) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx(); // создаём синхронно в обработчике касания
    const resumed = ctx.resume().catch(() => {});
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      ctx.close().catch(() => {});
      throw e;
    }
    await resumed;
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const ratio = ctx.sampleRate / RATE;
    const st = {
      rec, ctx, stream, src, proc, seq: 0, pending: [], pendingLen: 0, total: 0,
      started: Date.now(), saving: Promise.resolve(), stopped: false,
    };
    // понижение частоты до 16 кГц: фильтр (окно Блэкмана, срез 7,4 кГц), потом выборка с шагом ratio.
    // Простое усреднение срезает верхние частоты, и Whisper заметно хуже разбирает речь.
    const TAPS = 47, half = (TAPS - 1) / 2, fc = Math.min(0.5, 7400 / ctx.sampleRate);
    const h = new Float32Array(TAPS);
    let hs = 0;
    for (let i = 0; i < TAPS; i++) {
      const n = i - half;
      const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (TAPS - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (TAPS - 1));
      h[i] = sinc * w; hs += h[i];
    }
    for (let i = 0; i < TAPS; i++) h[i] /= hs;
    st.hist = new Float32Array(TAPS); // последние входные отсчёты
    st.next = 0; // позиция следующего выходного отсчёта во входном потоке (дробная)
    st.seen = 0; // сколько входных отсчётов прошло
    const filtered = (buf, base, at) => { // фильтр в точке at (номер входного отсчёта)
      let acc = 0;
      for (let k = 0; k < TAPS; k++) {
        const idx = at - half + k - base;
        const v = idx >= 0 ? buf[idx] : st.hist[TAPS + idx];
        acc += (v || 0) * h[k];
      }
      return acc;
    };
    proc.onaudioprocess = e => {
      if (st.stopped) return;
      const x = e.inputBuffer.getChannelData(0);
      const base = st.seen;
      const out = new Int16Array(Math.ceil(x.length / ratio) + 2);
      let k = 0, sum = 0;
      for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
      // выходной отсчёт можно посчитать, когда есть half отсчётов справа
      while (st.next + half < base + x.length) {
        const at = Math.round(st.next);
        const v = Math.max(-1, Math.min(1, filtered(x, base, at)));
        out[k++] = v * 32767;
        st.next += ratio;
      }
      // хвост блока в историю
      if (x.length >= TAPS) st.hist.set(x.subarray(x.length - TAPS));
      else { st.hist.copyWithin(0, x.length); st.hist.set(x, TAPS - x.length); }
      st.seen += x.length;
      const pcm = out.slice(0, k);
      st.pending.push(pcm); st.pendingLen += k; st.total += k;
      if (onLevel) onLevel(Math.min(1, Math.sqrt(sum / x.length) * 4));
      if (st.pendingLen >= RATE) this._save(st); // раз в секунду на диск
    };
    src.connect(proc);
    // ScriptProcessor работает, только если подключён к выходу; звук наружу не идёт (на выход пишем тишину)
    const mute = ctx.createGain(); mute.gain.value = 0;
    proc.connect(mute); mute.connect(ctx.destination);
    st.mute = mute;
    this.active = st;
    return st;
  }

  _save(st) {
    if (!st.pendingLen) return st.saving;
    const all = new Int16Array(st.pendingLen);
    let o = 0;
    for (const p of st.pending) { all.set(p, o); o += p.length; }
    st.pending = []; st.pendingLen = 0;
    const seq = st.seq++;
    st.saving = st.saving.then(() => idb.addChunk(st.rec, seq, all.buffer)).catch(e => console.error('chunk', e));
    return st.saving;
  }

  get elapsed() { return this.active ? this.active.total / RATE * 1000 : 0; }

  /** Остановить и дописать хвост. Возвращает id записи */
  async stop() {
    const st = this.active;
    if (!st) return null;
    this.active = null;
    st.stopped = true;
    try { st.src.disconnect(); st.proc.disconnect(); st.mute.disconnect(); } catch {}
    st.stream.getTracks().forEach(t => t.stop());
    st.ctx.close().catch(() => {});
    await this._save(st);
    return st.rec;
  }
}

// ---- проигрывание ----
let audioEl = null, playingId = null, url = null;
const listeners = new Set();
export const onPlaying = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach(f => f(playingId));
export const playing = () => playingId;

export async function toggle(id, file) {
  if (playingId === id) { stopPlay(); return; }
  stopPlay();
  const blob = await idb.get('files', file);
  if (!blob) return;
  url = URL.createObjectURL(blob);
  audioEl = new Audio(url);
  audioEl.onended = stopPlay;
  playingId = id; emit();
  audioEl.play().catch(stopPlay);
}
export function stopPlay() {
  if (audioEl) { audioEl.pause(); audioEl = null; }
  if (url) { URL.revokeObjectURL(url); url = null; }
  if (playingId) { playingId = null; emit(); }
}
