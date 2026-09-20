'use client';

import * as React from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTheme, type ThemePreference } from '@/components/theme-provider';

const OPTIONS: Array<{ value: ThemePreference; label: string; hint: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', hint: 'Always light', icon: Sun },
  { value: 'dark', label: 'Dark', hint: 'Always dark', icon: Moon },
  { value: 'system', label: 'System', hint: 'Follow your device', icon: Monitor },
];

/**
 * Theme switcher.
 *
 * Exposes all three preferences (including "follow the device") rather than a
 * binary toggle, because a phone set to dark mode and a desktop set to light
 * mode is the common case. The trigger shows the *resolved* theme so the icon
 * always matches what is on screen.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { preference, resolved, setPreference } = useTheme();
  const ActiveIcon = resolved === 'dark' ? Moon : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={className}
          aria-label={`Theme: ${preference}. Change colour theme`}
          title={`Theme: ${preference}`}
        >
          <ActiveIcon className="h-[1.15rem] w-[1.15rem]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const active = preference === option.value;
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => setPreference(option.value)}
              className="flex items-center gap-2"
            >
              <Icon className="h-4 w-4" />
              <span className="flex-1">
                {option.label}
                <span className="block text-[11px] text-muted-foreground">{option.hint}</span>
              </span>
              {active ? <Check className="h-4 w-4 text-primary" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
