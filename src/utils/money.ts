 

export function toPaisa(raw: string | number): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return Math.round(raw * 100);
  }
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/[৳,\s]/g, '')
    .replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
  if (!cleaned || !/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  const paisa = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(paisa) || paisa < 0) return null;
  return paisa;
}

export function fromPaisa(paisa: number): string {
  const neg = paisa < 0;
  const abs = Math.abs(Math.round(paisa));
  const whole = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${cents}`;
}

export function formatBDT(paisa: number, opts: { showSign?: boolean; compact?: boolean } = {}): string {
  const n = Math.round(paisa || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  if (opts.compact && abs >= 100_000_00) {
    return `${neg ? '-' : opts.showSign && n > 0 ? '+' : ''}৳${(abs / 100_000_00).toFixed(2)}Cr`;
  }
  const whole = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  const formatted = whole.toLocaleString('en-US');
  const sign = neg ? '-' : opts.showSign && n > 0 ? '+' : '';
  return `${sign}৳${formatted}.${cents}`;
}

export function formatDeltaBDT(deltaPaisa: number): string {
  if (!deltaPaisa) return '৳0.00';
  return formatBDT(deltaPaisa, { showSign: true });
}
