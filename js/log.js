// Короткий журнал для отчёта о проблеме: последние 60 событий в памяти телефона.
const KEY = 'bn_log';
export function log(text) {
  try {
    const l = JSON.parse(localStorage.getItem(KEY) || '[]');
    const d = new Date();
    l.push(d.toLocaleDateString('ru') + ' ' + d.toLocaleTimeString('ru') + ' ' + String(text).slice(0, 400));
    localStorage.setItem(KEY, JSON.stringify(l.slice(-60)));
  } catch {}
  console.log('[bn]', text);
}
export function readLog() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } }

window.addEventListener('error', e => log('ошибка: ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno));
window.addEventListener('unhandledrejection', e => log('ошибка: ' + (e.reason && e.reason.message || e.reason)));
