const eur = new Intl.NumberFormat('sk-SK', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

export const fmtEur = (n: number | null | undefined): string => (n == null ? '—' : eur.format(n));
export const fmtPct = (r: number | null | undefined, signed = false): string =>
  r == null ? '—' : `${signed && r > 0 ? '+' : ''}${Math.round(r * 100)} %`;
export const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('sk-SK');
};
