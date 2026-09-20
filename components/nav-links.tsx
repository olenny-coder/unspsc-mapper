'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  BarChart3,
  FileText,
  GitBranch,
  LayoutDashboard,
  ScrollText,
  Settings,
  Upload,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/hierarchy', label: 'Hierarchy', icon: GitBranch },
  { href: '/review', label: 'Review', icon: Activity },
  { href: '/reports', label: 'Reports', icon: FileText },
  { href: '/audit', label: 'Audit', icon: ScrollText },
  { href: '/upload', label: 'Upload', icon: Upload },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

/**
 * Primary navigation.
 *
 * `orientation="horizontal"` is used in the desktop header; `vertical` is used
 * inside the mobile panel, where items become full-width rows.
 */
export function NavLinks({
  orientation = 'horizontal',
  onNavigate,
}: {
  orientation?: 'horizontal' | 'vertical';
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const vertical = orientation === 'vertical';

  return (
    <nav
      className={cn(
        vertical ? 'flex flex-col gap-1' : 'flex flex-wrap items-center gap-1',
      )}
      aria-label="Main"
    >
      {LINKS.map((link) => {
        const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
        const Icon = link.icon;
        return (
          <Link
            key={link.href}
            href={link.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors',
              // Comfortable touch target on mobile, compact on desktop.
              vertical ? 'w-full px-3 py-2.5 text-sm' : 'px-3 py-2 text-sm',
              active
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {link.label}
          </Link>
        );
      })}

      {vertical ? (
        <Link
          href="/api/health"
          target="_blank"
          onClick={onNavigate}
          className="inline-flex w-full items-center gap-1.5 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <BarChart3 className="h-4 w-4 shrink-0" />
          Health endpoint
        </Link>
      ) : (
        <Link
          href="/api/health"
          target="_blank"
          className="ml-1 hidden items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground xl:inline-flex"
        >
          <BarChart3 className="h-3.5 w-3.5" />
          /api/health
        </Link>
      )}
    </nav>
  );
}
