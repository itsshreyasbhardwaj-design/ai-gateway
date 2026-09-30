'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity, AlertTriangle, BarChart3, Boxes, Coins, FlaskConical, FolderTree,
  KeyRound, Route, Server, Settings, Webhook,
} from 'lucide-react';
import { cn } from '@ai-gateway/ui';

const SECTIONS: Array<{ label: string; items: Array<{ href: string; label: string; icon: typeof Activity }> }> = [
  {
    label: 'Observe',
    items: [
      { href: '/dashboard', label: 'Overview', icon: Activity },
      { href: '/requests', label: 'Requests', icon: BarChart3 },
      { href: '/usage', label: 'Usage', icon: Coins },
      { href: '/alerts', label: 'Alerts', icon: AlertTriangle },
    ],
  },
  {
    label: 'Route',
    items: [
      { href: '/models', label: 'Models', icon: Boxes },
      { href: '/providers', label: 'Providers', icon: Server },
      { href: '/routing', label: 'Routing', icon: Route },
      { href: '/playground', label: 'Playground', icon: FlaskConical },
    ],
  },
  {
    label: 'Govern',
    items: [
      { href: '/projects', label: 'Projects', icon: FolderTree },
      { href: '/api-keys', label: 'API keys', icon: KeyRound },
      { href: '/budgets', label: 'Budgets', icon: Coins },
      { href: '/webhooks', label: 'Webhooks', icon: Webhook },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="flex h-full w-52 shrink-0 flex-col border-r border-surface-border bg-surface-raised">
      <div className="flex h-12 items-center gap-2 border-b border-surface-border px-4">
        <span className="h-2 w-2 rounded-full bg-accent" aria-hidden />
        <span className="text-sm font-semibold tracking-tight text-zinc-100">AI Gateway</span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {SECTIONS.map((section) => (
          <div key={section.label} className="mb-4">
            <p className="px-2 pb-1 text-2xs font-medium uppercase tracking-wider text-zinc-600">{section.label}</p>
            <ul>
              {section.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors',
                        active
                          ? 'bg-accent/15 font-medium text-accent'
                          : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
                      )}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
