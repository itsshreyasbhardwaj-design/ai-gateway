'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCompact, formatCurrency, formatDuration, seriesColor } from '@ai-gateway/ui';

/**
 * Charts.
 *
 * Restrained on purpose: thin strokes, one colour per series, no drop shadows,
 * and axis labels that stay legible at a glance. Every tooltip states the unit
 * so a number is never ambiguous.
 */

const AXIS = {
  stroke: '#3f3f46',
  tick: { fill: '#71717a', fontSize: 10 },
};

const TOOLTIP_STYLE = {
  contentStyle: {
    background: '#18181b',
    border: '1px solid #27272a',
    borderRadius: 6,
    fontSize: 11,
    padding: '6px 8px',
  },
  labelStyle: { color: '#a1a1aa', marginBottom: 2 },
  itemStyle: { color: '#e4e4e7' },
};

function bucketLabel(iso: string, bucketMs: number): string {
  const date = new Date(iso);
  // Sub-daily buckets show the time; daily and coarser show the date.
  if (bucketMs < 86_400_000) return date.toISOString().slice(11, 16);
  return date.toISOString().slice(5, 10);
}

export interface SeriesPoint {
  bucket: string;
  requests: number;
  errors: number;
  tokens: number;
  cost: number;
  avgLatencyMs: number;
  cacheHits: number;
}

export function RequestsChart({ data, bucketMs }: { data: SeriesPoint[]; bucketMs: number }) {
  const shaped = data.map((point) => ({
    label: bucketLabel(point.bucket, bucketMs),
    successful: Math.max(0, point.requests - point.errors),
    errors: point.errors,
  }));

  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={shaped} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid stroke="#27272a" strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={28} />
        <YAxis {...AXIS} tickFormatter={(v: number) => formatCompact(v)} width={44} />
        <Tooltip {...TOOLTIP_STYLE} formatter={(value: number, name) => [formatCompact(value), name]} />
        <Area
          type="monotone"
          dataKey="successful"
          stackId="1"
          stroke="#22d3ee"
          fill="#22d3ee"
          fillOpacity={0.14}
          strokeWidth={1.5}
          name="successful"
        />
        <Area
          type="monotone"
          dataKey="errors"
          stackId="1"
          stroke="#f87171"
          fill="#f87171"
          fillOpacity={0.18}
          strokeWidth={1.5}
          name="errors"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function TokensChart({ data, bucketMs }: { data: SeriesPoint[]; bucketMs: number }) {
  const shaped = data.map((point) => ({ label: bucketLabel(point.bucket, bucketMs), tokens: point.tokens }));
  return (
    <ResponsiveContainer width="100%" height={160}>
      <BarChart data={shaped} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid stroke="#27272a" strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={28} />
        <YAxis {...AXIS} tickFormatter={(v: number) => formatCompact(v)} width={44} />
        <Tooltip {...TOOLTIP_STYLE} formatter={(value: number) => [formatCompact(value), 'tokens']} />
        <Bar dataKey="tokens" fill="#a78bfa" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function CostChart({ data, bucketMs, currency }: { data: SeriesPoint[]; bucketMs: number; currency: string }) {
  const shaped = data.map((point) => ({ label: bucketLabel(point.bucket, bucketMs), cost: point.cost }));
  return (
    <ResponsiveContainer width="100%" height={160}>
      <AreaChart data={shaped} margin={{ top: 8, right: 8, bottom: 0, left: -6 }}>
        <CartesianGrid stroke="#27272a" strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={28} />
        <YAxis {...AXIS} tickFormatter={(v: number) => formatCurrency(v, currency)} width={64} />
        <Tooltip {...TOOLTIP_STYLE} formatter={(value: number) => [formatCurrency(value, currency), 'estimated cost']} />
        <Area type="monotone" dataKey="cost" stroke="#34d399" fill="#34d399" fillOpacity={0.14} strokeWidth={1.5} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function LatencyChart({ data, bucketMs }: { data: SeriesPoint[]; bucketMs: number }) {
  const shaped = data.map((point) => ({ label: bucketLabel(point.bucket, bucketMs), latency: point.avgLatencyMs }));
  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={shaped} margin={{ top: 8, right: 8, bottom: 0, left: -6 }}>
        <CartesianGrid stroke="#27272a" strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={28} />
        <YAxis {...AXIS} tickFormatter={(v: number) => `${Math.round(v)}ms`} width={56} />
        <Tooltip {...TOOLTIP_STYLE} formatter={(value: number) => [formatDuration(value), 'avg latency']} />
        <Line type="monotone" dataKey="latency" stroke="#fbbf24" strokeWidth={1.5} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export interface DistributionSlice {
  key: string;
  requests: number;
}

/**
 * Horizontal distribution bars rather than a pie chart: comparing lengths along
 * a shared baseline is more accurate than comparing angles, and the labels stay
 * readable when a provider id is long.
 */
export function DistributionChart({ data, unit = 'requests' }: { data: DistributionSlice[]; unit?: string }) {
  const top = data.slice(0, 8);
  return (
    <ResponsiveContainer width="100%" height={Math.max(120, top.length * 30 + 20)}>
      <BarChart data={top} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
        <CartesianGrid stroke="#27272a" strokeDasharray="2 4" horizontal={false} />
        <XAxis type="number" {...AXIS} tickFormatter={(v: number) => formatCompact(v)} />
        <YAxis type="category" dataKey="key" {...AXIS} width={140} tick={{ fill: '#a1a1aa', fontSize: 10 }} />
        <Tooltip {...TOOLTIP_STYLE} formatter={(value: number) => [formatCompact(value), unit]} />
        <Bar dataKey="requests" radius={[0, 2, 2, 0]}>
          {top.map((_slice, index) => (
            <Cell key={index} fill={seriesColor(index)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
