/**
 * Design tokens.
 *
 * The target is an infrastructure console, not a marketing page: dense tables,
 * a single accent, monospace for anything an operator might copy, and no
 * decoration that competes with the data. Deliberately no gradients, no
 * glassmorphism, and no motion that implies activity which is not happening.
 */

export const STATUS_STYLES = {
  success: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  error: 'text-red-400 bg-red-500/10 border-red-500/20',
  cancelled: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  pending: 'text-sky-400 bg-sky-500/10 border-sky-500/20',
  neutral: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/20',
} as const;

export type StatusTone = keyof typeof STATUS_STYLES;

export const HEALTH_TONES: Record<string, StatusTone> = {
  healthy: 'success',
  degraded: 'cancelled',
  unavailable: 'error',
  unknown: 'neutral',
};

export const CIRCUIT_TONES: Record<string, StatusTone> = {
  CLOSED: 'success',
  HALF_OPEN: 'cancelled',
  OPEN: 'error',
};

/**
 * Categorical series colours.
 *
 * Chosen to stay distinguishable on a dark background and to survive the most
 * common forms of colour-vision deficiency. Order matters: charts assign them
 * by index.
 */
export const SERIES_COLORS = [
  '#38bdf8',
  '#a78bfa',
  '#34d399',
  '#fbbf24',
  '#f472b6',
  '#22d3ee',
  '#fb923c',
  '#818cf8',
] as const;

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length] ?? SERIES_COLORS[0];
}

// ----------------------------------------------------------- formatting

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('en-US');
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (Math.abs(value) < 1000) return String(Math.round(value));
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatCurrency(amount: number | null | undefined, currency = 'USD'): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '—';
  const symbol = currency === 'USD' ? '$' : currency === 'INR' ? '₹' : currency === 'EUR' ? '€' : '';
  if (amount === 0) return `${symbol}0.00`;
  // Sub-cent costs are normal per request, so do not round them away.
  if (Math.abs(amount) < 0.01) return `${symbol}${amount.toFixed(6)}`;
  if (Math.abs(amount) < 1) return `${symbol}${amount.toFixed(4)}`;
  return `${symbol}${amount.toFixed(2)}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  return new Date(parsed).toISOString().replace('T', ' ').slice(0, 19);
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return formatCompact(value);
}
