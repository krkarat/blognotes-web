// Отдельный поток для Whisper, чтобы интерфейс не замирал во время расшифровки.
/* global importScripts, createWhisper, FileReaderSync */
importScripts('../whisper/whisper.js');

let mod = null, ctx = 0, ctxKey = null;
// чтение модели кусками из Blob: в памяти не держим файл целиком
let blob = null, pos = 0, win = null, winStart = 0;
const WIN = 1 << 20;
const fr = new FileReaderSync();

function readModel(dst, size) {
  let done = 0;
  while (done < size && pos < blob.size) {
    if (!win || pos < winStart || pos >= winStart + win.length) {
      winStart = pos;
      win = new Uint8Array(fr.readAsArrayBuffer(blob.slice(pos, Math.min(blob.size, pos + Math.max(WIN, size - done)))));
    }
    const off = pos - winStart;
    const n = Math.min(size - done, win.length - off);
    mod.HEAPU8.set(win.subarray(off, off + n), dst + done);
    done += n; pos += n;
  }
  return done;
}

async function ensureModule() {
  if (mod) return mod;
  mod = await createWhisper({
    locateFile: f => '../whisper/' + f,
    readModel, modelEof: () => pos >= blob.size,
    log: s => postMessage({ type: 'log', text: s }),
    progress: p => postMessage({ type: 'progress', p }),
  });
  return mod;
}

onmessage = async e => {
  const m = e.data;
  try {
    if (m.cmd === 'init') {
      await ensureModule();
      if (ctx && ctxKey === m.key) { postMessage({ type: 'ready' }); return; }
      if (ctx) { mod._wn_free(ctx); ctx = 0; }
      blob = new Blob(m.parts); pos = 0; win = null;
      const t = performance.now();
      ctx = mod._wn_init();
      blob = null; win = null;
      if (!ctx) throw new Error('модель не загрузилась');
      ctxKey = m.key;
      postMessage({ type: 'ready', ms: Math.round(performance.now() - t) });
    } else if (m.cmd === 'run') {
      const pcm = m.pcm;
      const p = mod._malloc(pcm.length * 4);
      mod.HEAPF32.set(pcm, p >> 2);
      const lang = mod.stringToNewUTF8(m.lang || 'ru');
      const t = performance.now();
      const r = mod._wn_transcribe(ctx, p, pcm.length, 1, lang, 0); // audio_ctx 0: полное окно, укороченное режет русский текст
      mod._free(p); mod._free(lang);
      if (!r) throw new Error('расшифровка не удалась');
      const text = mod.UTF8ToString(r);
      mod._free(r);
      postMessage({ type: 'text', text, ms: Math.round(performance.now() - t) });
    }
  } catch (err) {
    postMessage({ type: 'error', error: String(err && err.message || err) });
  }
};
