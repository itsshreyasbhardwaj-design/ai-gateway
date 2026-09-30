'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import { cn } from '@ai-gateway/ui';

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'sm',
  type = 'button',
  disabled,
  className,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  type?: 'button' | 'submit';
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const variants = {
    default: 'border-surface-border bg-surface-overlay text-zinc-200 hover:bg-zinc-800',
    primary: 'border-accent/40 bg-accent/15 text-accent hover:bg-accent/25',
    danger: 'border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20',
    ghost: 'border-transparent bg-transparent text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
        variants[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Input({
  name,
  defaultValue,
  placeholder,
  type = 'text',
  required,
  className,
  mono,
  step,
  min,
}: {
  name: string;
  defaultValue?: string | number;
  placeholder?: string;
  type?: string;
  required?: boolean;
  className?: string;
  mono?: boolean;
  step?: string;
  min?: string;
}) {
  return (
    <input
      name={name}
      type={type}
      step={step}
      min={min}
      defaultValue={defaultValue}
      placeholder={placeholder}
      required={required}
      className={cn(
        'w-full rounded border border-surface-border bg-surface px-2.5 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600',
        mono && 'font-mono',
        className,
      )}
    />
  );
}

export function Select({
  name,
  options,
  defaultValue,
  className,
}: {
  name: string;
  options: Array<{ value: string; label: string }>;
  defaultValue?: string;
  className?: string;
}) {
  return (
    <select
      name={name}
      defaultValue={defaultValue}
      className={cn(
        'rounded border border-surface-border bg-surface px-2 py-1.5 text-xs text-zinc-200',
        className,
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-2xs font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-2xs leading-relaxed text-zinc-600">{hint}</span>}
    </label>
  );
}

/**
 * Query-string filter control.
 *
 * Filters live in the URL rather than component state so an operator can share
 * a link to exactly the view they are looking at - which is most of the value of
 * a request log.
 */
export function QueryFilter({
  param,
  options,
  label,
}: {
  param: string;
  options: Array<{ value: string; label: string }>;
  label: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const current = searchParams.get(param) ?? '';

  const apply = (value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(param, value);
    else next.delete(param);
    next.delete('cursor');
    startTransition(() => router.push(`${pathname}?${next.toString()}`));
  };

  return (
    <label className={cn('flex items-center gap-1.5', isPending && 'opacity-60')}>
      <span className="text-2xs uppercase tracking-wider text-zinc-500">{label}</span>
      <select
        value={current}
        onChange={(event) => apply(event.target.value)}
        className="rounded border border-surface-border bg-surface px-2 py-1 text-xs text-zinc-200"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SearchBox({
  param = 'search',
  placeholder,
}: {
  param?: string;
  placeholder?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(searchParams.get(param) ?? '');
  const [isPending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(param, value);
    else next.delete(param);
    next.delete('cursor');
    startTransition(() => router.push(`${pathname}?${next.toString()}`));
  };

  return (
    <form onSubmit={submit} className={cn('flex items-center gap-1.5', isPending && 'opacity-60')}>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder ?? 'Search…'}
        className="w-56 rounded border border-surface-border bg-surface px-2.5 py-1 font-mono text-xs text-zinc-200 placeholder:text-zinc-600"
      />
      <Button type="submit" size="sm">
        Search
      </Button>
    </form>
  );
}

export function RangeTabs({ param = 'range', current }: { param?: string; current: string }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const ranges = ['1h', '24h', '7d', '30d', '90d'];

  return (
    <div className="inline-flex rounded border border-surface-border bg-surface-overlay p-0.5">
      {ranges.map((range) => {
        const next = new URLSearchParams(searchParams.toString());
        next.set(param, range);
        const active = current === range;
        return (
          <Link
            key={range}
            href={`${pathname}?${next.toString()}`}
            className={cn(
              'rounded px-2 py-0.5 text-xs font-medium transition-colors',
              active ? 'bg-accent/20 text-accent' : 'text-zinc-500 hover:text-zinc-300',
            )}
          >
            {range}
          </Link>
        );
      })}
    </div>
  );
}

export function Toggle({ param, label, hint }: { param: string; label: string; hint?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const enabled = searchParams.get(param) === 'true';

  const toggle = () => {
    const next = new URLSearchParams(searchParams.toString());
    if (enabled) next.delete(param);
    else next.set(param, 'true');
    router.push(`${pathname}?${next.toString()}`);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      title={hint}
      className={cn(
        'inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs transition-colors',
        enabled
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
          : 'border-surface-border bg-surface-overlay text-zinc-500 hover:text-zinc-300',
      )}
    >
      <span
        className={cn('h-1.5 w-1.5 rounded-full', enabled ? 'bg-amber-400' : 'bg-zinc-600')}
        aria-hidden
      />
      {label}
    </button>
  );
}

/** Copy-to-clipboard for ids and keys an operator needs to paste elsewhere. */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}
