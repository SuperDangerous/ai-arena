/* ---------------------------------------------------------------------------
   Formatters. Numbers in a dashboard should be short enough to scan and
   precise enough to trust — these round hard at a glance and keep detail in
   tooltips.

   makeFormat() returns a bound set so locale/currency live in one place:
     const fmt = makeFormat({ locale: 'en-IE', currency: 'EUR' });
     fmt.money(1234)     → '€1,234'
     fmt.money(41200, true) → '€41.2k'   (compact, for axes and tiles)
--------------------------------------------------------------------------- */

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };

export function makeFormat({ locale = 'en-IE', currency = 'USD', rate = 1, symbol } = {}) {
  const sym = symbol || SYMBOLS[currency] || '';

  const num = (v) => Math.round(v).toLocaleString(locale);

  const money = (v, compact) => {
    v = v * rate;
    const neg = v < 0; const a = Math.abs(v);
    const s = (x) => (neg ? '-' : '') + sym + x;
    if (compact && a >= 1000) return s((a / 1000).toFixed(a >= 10000 ? 0 : 1) + 'k');
    if (a >= 100) return s(Math.round(a).toLocaleString(locale));
    return s(a.toFixed(2));
  };

  /** Big counts: 1.45B / 12.3M / 4.2k */
  const compact = (v) => {
    const a = Math.abs(v), sign = v < 0 ? '-' : '';
    if (a >= 1e9) return sign + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return sign + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return sign + (a / 1e3).toFixed(1) + 'k';
    return sign + String(Math.round(a));
  };

  const pct = (v, dp = 0) => (v * 100).toFixed(dp) + '%';

  /** ISO date → locale short date. Accepts 'YYYY-MM-DD' or a full timestamp. */
  const date = (iso) => {
    const d = String(iso || '').slice(0, 10).split('-');
    if (d.length !== 3) return iso || '';
    return locale.startsWith('en-US') ? `${d[1]}/${d[2]}/${d[0]}` : `${d[2]}/${d[1]}/${d[0]}`;
  };

  const dateTime = (iso) => (iso ? new Date(iso).toLocaleString(locale) : '');

  /** 2h 15m / 45m / 30s — for durations held in seconds. */
  const duration = (secs) => {
    if (secs >= 3600) { const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60); return m ? `${h}h ${m}m` : `${h}h`; }
    if (secs >= 60) return `${Math.round(secs / 60)}m`;
    return `${Math.round(secs)}s`;
  };

  /** Signed delta for tile subtitles: '+12.4%' / '-3.1%' */
  const delta = (v, dp = 1) => (v > 0 ? '+' : '') + (v * 100).toFixed(dp) + '%';

  return { num, money, compact, pct, date, dateTime, duration, delta, locale, currency };
}

/** Local calendar day key ('YYYY-MM-DD') — never use toISOString(), it's UTC. */
export function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Contiguous day keys ending today; days=0 means "since `from`". */
export function dayRange(days, from) {
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const start = days > 0 ? new Date(end.getTime() - (days - 1) * 864e5) : new Date(from || end);
  start.setHours(0, 0, 0, 0);
  const keys = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 864e5) keys.push(dayKey(new Date(t)));
  return keys;
}
