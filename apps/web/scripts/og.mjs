// Vyrenderuje og/og.html → public/og.png (1200×630) cez headless Chrome/Edge.
// Spúšťa sa ručne po zmene dizajnu (pnpm --filter @skfirma/web og), PNG je v gite.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = fileURLToPath(new URL('../og/og.html', import.meta.url));
const out = fileURLToPath(new URL('../public/og.png', import.meta.url));

const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) {
  console.error('Nenašiel som Chrome/Edge — nastav CHROME_PATH.');
  process.exit(1);
}

mkdirSync(fileURLToPath(new URL('../public/', import.meta.url)), { recursive: true });
execFileSync(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1200,630',
  '--virtual-time-budget=8000', // počkať na webfont
  `--screenshot=${out}`,
  pathToFileURL(src).href,
], { stdio: 'inherit' });
console.log(`og.png: ${Math.round(statSync(out).size / 1024)} kB → ${out}`);
