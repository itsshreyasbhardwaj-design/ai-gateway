import type { ReactNode } from 'react';
import { cn, STATUS_STYLES, type StatusTone } from '@ai-gateway/ui';

/**
 * UI primitives.
 *
 * Small and local rather than a component library: this console needs a dozen
 * shapes, and every one of them should be readable in a single file next to the
 * screens that use it.
 */

export function Panel({
  children,
  className,
  title,
  subtitle,
  actions,
  scroll,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  scroll?: boolean;
}) {
  return (
    <section className={cn('panel min-w-0', className)}>
      {(title || actions) && (
        <header className="panel-header">
          <div className="min-w-0">
            {title && <h2 className="truncate text-sm font-medium text-zinc-200">{title}</h2>}
            {subtitle && <p className="mt-0.5 truncate text-xs text-zinc-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(scroll && 'max-h-[28rem] overflow-auto')}>{children}</div>
    </section>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  className,
  title,
}: {
  children: ReactNode;
  tone?: StatusTone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide',
        STATUS_STYLES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Mono({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span title={title} className={cn('font-mono text-xs text-zinc-300', className)}>
      {children}
    </span>
  );
}

/**
 * A stat tile.
 *
 * `hint` exists so a number can carry its own caveat - an estimated cost or a
 * stale pricing table is stated next to the figure, not in a footnote nobody
 * reads.
 */
export function Stat({
  label,
  value,
  hint,
  tone,
  sub,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'default' | 'warn' | 'danger' | 'good';
  sub?: ReactNode;
}) {
  const valueTone =
    tone === 'warn'
      ? 'text-amber-300'
      : tone === 'danger'
        ? 'text-red-300'
        : tone === 'good'
          ? 'text-emerald-300'
          : 'text-zinc-100';
  return (
    <div className="panel px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xs font-medium uppercase tracking-wider text-zinc-500">{label}</span>
        {hint && (
          <span title={hint} className="cursor-help text-2xs text-zinc-600">
            ⓘ
          </span>
        )}
      </div>
      <div className={cn('tabular mt-1.5 text-xl font-semibold', valueTone)}>{value}</div>
      {sub && <div className="mt-1 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      {body && <p className="max-w-md text-xs leading-relaxed text-zinc-500">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'danger';
  title?: ReactNode;
  children: ReactNode;
}) {
  const styles =
    tone === 'warn'
      ? 'border-amber-500/30 bg-amber-500/[0.07] text-amber-200'
      : tone === 'danger'
        ? 'border-red-500/30 bg-red-500/[0.07] text-red-200'
        : 'border-sky-500/30 bg-sky-500/[0.07] text-sky-200';
  return (
    <div className={cn('rounded-lg border px-4 py-3 text-xs leading-relaxed', styles)}>
      {title && <p className="mb-1 font-medium">{title}</p>}
      <div className="text-current/90">{children}</div>
    </div>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cn('data-table tabular', className)}>{children}</table>
    </div>
  );
}

export function Th({
  children,
  align = 'left',
  className,
}: {
  children?: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  return (
    <th
      className={cn(
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  className,
  title,
}: {
  children?: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  title?: string;
}) {
  return (
    <td
      title={title}
      className={cn(
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </td>
  );
}

/**
 * Horizontal proportion bar.
 *
 * Used for budget utilization and share-of-traffic, where the number matters
 * more than the bar - so the bar is subordinate and the value is always shown.
 */
export function Meter({
  value,
  tone = 'default',
}: {
  value: number;
  tone?: 'default' | 'warn' | 'danger';
}) {
  const pct = Math.max(0, Math.min(100, value * 100));
  const fill = tone === 'danger' ? 'bg-red-500' : tone === 'warn' ? 'bg-amber-400' : 'bg-accent';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800" role="presentation">
      <div
        className={cn('h-full rounded-full transition-all', fill)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-zinc-100">{title}</h1>
        {description && (
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-zinc-500">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-surface-border/60 px-4 py-2 last:border-0">
      <span className="shrink-0 text-xs text-zinc-500">{label}</span>
      <span className="min-w-0 text-right text-xs text-zinc-200">{children}</span>
    </div>
  );
}

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-2xs text-zinc-400',
        className,
      )}
    >
      {children}
    </span>
  );
}
