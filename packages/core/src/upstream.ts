// Strážca odchádzajúcich dopytov na verejné API (RPO, RÚZ, Dôvera).
// Tri vrstvy, od najlacnejšej:
//   1. throttle  — max ~2 req/s na host (minIntervalMs), dopyty idú za sebou
//   2. fronta    — keď čaká viac ako maxQueuePerHost dopytov, ďalší hneď
//                  dostane BusyError namiesto nekonečného čakania
//   3. rozpočet  — max dailyBudgetPerHost dopytov na host za deň
// Limit na IP (apps/server) chráni pred jedným klientom; toto chráni zdroj
// pred súčtom všetkých klientov.
import { CONFIG } from './config.js';
import { BusyError } from './errors.js';

interface HostState {
  queued: number;
  day: string;
  used: number;
  rejected: number;
  tail: Promise<void>;
}

const hosts = new Map<string, HostState>();
const today = () => new Date().toISOString().slice(0, 10);

function state(host: string): HostState {
  let s = hosts.get(host);
  if (!s) {
    s = { queued: 0, day: today(), used: 0, rejected: 0, tail: Promise.resolve() };
    hosts.set(host, s);
  }
  const d = today();
  if (s.day !== d) { s.day = d; s.used = 0; s.rejected = 0; }
  return s;
}

const secondsToUtcMidnight = (): number => {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.ceil((midnight - now.getTime()) / 1000);
};

/**
 * Počká na slot pre jeden odchádzajúci dopyt na `host`, alebo hodí BusyError.
 * Volaj tesne pred každým fetchom (aj pred retry).
 */
export async function acquireUpstreamSlot(host: string): Promise<void> {
  const s = state(host);
  if (s.used >= CONFIG.http.dailyBudgetPerHost) {
    s.rejected++;
    throw new BusyError(
      `Server dnes vyčerpal denný limit dopytov na zdroj ${host} (ochrana verejného API). Skús to zajtra.`,
      secondsToUtcMidnight(),
    );
  }
  if (s.queued >= CONFIG.http.maxQueuePerHost) {
    s.rejected++;
    throw new BusyError('Server je momentálne vyťažený — veľa súbežných previerok. Skús to o minútu.', 30);
  }
  s.queued++;
  const prev = s.tail;
  let release!: () => void;
  s.tail = new Promise<void>((r) => (release = r));
  try {
    await prev;
  } finally {
    s.queued--;
    s.used++;
    setTimeout(release, CONFIG.http.minIntervalMs);
  }
}

export interface UpstreamStats {
  host: string;
  day: string;
  used: number;
  budget: number;
  queued: number;
  rejected: number;
}

export function upstreamStats(): UpstreamStats[] {
  return [...hosts.keys()].map((host) => {
    const s = state(host);
    return { host, day: s.day, used: s.used, budget: CONFIG.http.dailyBudgetPerHost, queued: s.queued, rejected: s.rejected };
  });
}

/** Len pre testy. */
export function resetUpstreamState(): void {
  hosts.clear();
}
