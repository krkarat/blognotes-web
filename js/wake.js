// Не даём экрану погаснуть, пока идёт запись или расшифровка (Wake Lock, iOS 16.4+).
const reasons = new Set();
let lock = null;

async function apply() {
  if (reasons.size && !lock && document.visibilityState === 'visible' && navigator.wakeLock) {
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } catch { lock = null; }
  } else if (!reasons.size && lock) {
    lock.release().catch(() => {}); lock = null;
  }
}
export function keepAwake(reason) { reasons.add(reason); apply(); }
export function release(reason) { reasons.delete(reason); apply(); }
export const supported = () => !!navigator.wakeLock;
// после возврата в приложение замок нужно взять заново
document.addEventListener('visibilitychange', apply);
