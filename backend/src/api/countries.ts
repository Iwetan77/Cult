// Countries members can pick: ISO 3166-1 alpha-2, named by the runtime's ICU
// data. Groupings like EU/UN aren't countries, so they're refused.
const names = new Intl.DisplayNames(['en'], { type: 'region' });
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'XA', 'XB', 'QO', 'ZZ']);

export function countryName(code: string): string | null {
  const c = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || NOT_COUNTRIES.has(c)) return null;
  const n = names.of(c);
  return n && n !== c ? n : null;
}
