// Zdieľané parse helpery ingestu. Žiadne I/O, žiadna biznis logika.

export function parseAmountEur(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/[\s ]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

const XML_ENTITIES: Record<string, string> = {
  '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&apos;': "'", '&#39;': "'",
};

export function decodeXmlEntities(s: string): string {
  return s.replace(/&quot;|&amp;|&lt;|&gt;|&apos;|&#39;/g, (m) => XML_ENTITIES[m]);
}

export function ddmmyyyyToIso(s: string | null | undefined): string | null {
  if (!s || !/^\d{8}$/.test(s)) return null;
  return `${s.slice(4, 8)}-${s.slice(2, 4)}-${s.slice(0, 2)}`;
}

export function dmyToIso(s: string | null | undefined): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s ?? '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// ISO 8601: týždeň 1 = týždeň obsahujúci prvý štvrtok roka; pondelok = deň 1.
export function isoWeekMonday(week: number, year: number): string {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const week1Monday = new Date(jan4.getTime() - (jan4Dow - 1) * 86_400_000);
  const monday = new Date(week1Monday.getTime() + (week - 1) * 7 * 86_400_000);
  return monday.toISOString().slice(0, 10);
}
