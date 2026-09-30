/** Terminal output helpers. Kept dependency-free so `aigw` installs fast. */

const useColor = process.stdout.isTTY && !process.env['NO_COLOR'];

const code = (open: number, close: number) => (text: string) =>
  useColor ? `\u001b[${open}m${text}\u001b[${close}m` : text;

export const bold = code(1, 22);
export const dim = code(2, 22);
export const red = code(31, 39);
export const green = code(32, 39);
export const yellow = code(33, 39);
export const cyan = code(36, 39);

export function out(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function errOut(text: string): void {
  process.stderr.write(`${text}\n`);
}

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  align?: 'left' | 'right';
}

/** Plain aligned table. Wide values are truncated rather than wrapped. */
export function table<T>(rows: T[], columns: Column<T>[], maxWidth = 44): string {
  if (rows.length === 0) return dim('  (no rows)');

  const cells = rows.map((row) => columns.map((column) => truncate(column.value(row), maxWidth)));
  const widths = columns.map((column, i) =>
    Math.max(column.header.length, ...cells.map((r) => stripAnsi(r[i] ?? '').length)),
  );

  const renderRow = (values: string[], transform: (s: string) => string = (s) => s) =>
    `  ${values
      .map((value, i) => {
        const width = widths[i] ?? 0;
        const pad = ' '.repeat(Math.max(0, width - stripAnsi(value).length));
        return columns[i]?.align === 'right' ? pad + transform(value) : transform(value) + pad;
      })
      .join('  ')}`.trimEnd();

  const header = renderRow(columns.map((c) => c.header), bold);
  const rule = `  ${widths.map((w) => '-'.repeat(w)).join('  ')}`;
  return [header, dim(rule), ...cells.map((r) => renderRow(r))].join('\n');
}

export function truncate(value: string, max: number): string {
  const plain = stripAnsi(value);
  if (plain.length <= max) return value;
  return `${plain.slice(0, max - 1)}…`;
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

export function json(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

export function formatCost(amount: number | null | undefined, currency = 'USD'): string {
  if (amount === null || amount === undefined) return dim('-');
  const symbol = currency === 'USD' ? '$' : currency === 'INR' ? '₹' : '';
  if (amount === 0) return `${symbol}0`;
  if (amount < 0.01) return `${symbol}${amount.toFixed(6)}`;
  return `${symbol}${amount.toFixed(4)}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return dim('-');
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function statusBadge(status: string): string {
  if (status === 'success') return green('success');
  if (status === 'error') return red('error');
  if (status === 'cancelled') return yellow('cancelled');
  return status;
}

export function healthBadge(state: string): string {
  if (state === 'healthy') return green('healthy');
  if (state === 'degraded') return yellow('degraded');
  if (state === 'unavailable') return red('unavailable');
  return dim(state);
}
