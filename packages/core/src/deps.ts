import { RpoClient } from './clients/rpo.js';
import { RuzClient } from './clients/ruz.js';
import { DatasetIndex } from './clients/dataset-index.js';
import { DoveraClient } from './clients/dovera.js';
import { LruCache } from './cache.js';
import { CONFIG } from './config.js';
import type { Deps } from './services.js';

/** Produkčné závislosti: živí klienti nad verejnými API + lokálny SQLite index. */
export function createDefaultDeps(opts: { indexPath?: string } = {}): Deps {
  const cache = new LruCache<unknown>({ maxSize: CONFIG.cacheMaxSize });
  return {
    rpo: new RpoClient(cache),
    ruz: new RuzClient(cache),
    index: new DatasetIndex(opts.indexPath ?? CONFIG.index.path),
    dovera: new DoveraClient(cache),
  };
}
