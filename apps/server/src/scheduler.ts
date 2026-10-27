import { fork, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';

/**
 * Periodický ingest bez externého cronu — funguje rovnako na VPS, Fly, Railway
 * aj v lokálnom Dockeri. Pri štarte dobehne hneď, ak index chýba alebo je starší
 * ako interval. FS datasety majú ETag, takže zbytočný beh je lacný.
 */
export function scheduleIngest(opts: { indexPath: string; intervalHours: number }): () => void {
  const intervalMs = opts.intervalHours * 3600_000;
  let child: ChildProcess | null = null;

  const run = () => {
    if (child) return;
    const started = Date.now();
    console.error('[ingest] štart');
    child = fork(new URL('./ingest-worker.js', import.meta.url), { stdio: 'inherit' });
    child.on('exit', (code) => {
      child = null;
      console.error(`[ingest] koniec (kód ${code}, ${Math.round((Date.now() - started) / 1000)} s)`);
    });
  };

  let ageMs = Infinity;
  try { ageMs = Date.now() - statSync(opts.indexPath).mtimeMs; } catch { /* index ešte neexistuje */ }
  const firstIn = ageMs >= intervalMs ? 5_000 : intervalMs - ageMs;
  let timer = setTimeout(function tick() {
    run();
    timer = setTimeout(tick, intervalMs);
  }, firstIn);
  timer.unref();
  console.error(`[ingest] ďalší beh o ${Math.round(firstIn / 60_000)} min, potom každých ${opts.intervalHours} h`);
  // stop: zruší plán a ukončí bežiaci ingest (rozpracovaný <index>.new sa
  // nepoužije — ďalší beh ho zmaže, platný index ostáva nedotknutý)
  return () => {
    clearTimeout(timer);
    child?.kill('SIGTERM');
  };
}
