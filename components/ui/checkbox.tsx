'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  /*
   * A visually-small box with a large hit area: the glyph stays 16px so dense
   * tables remain readable, while `after:-inset-2` extends the touch target to
   * 32px in each direction. This is the standard trick for meeting WCAG 2.5.8
   * without inflating row height.
   */
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'peer relative h-4 w-4 shrink-0 rounded-sm border border-primary shadow',
      'after:absolute after:-inset-2 after:content-[""]',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className={cn('flex items-center justify-center text-current')}>
      <Check className="h-3.5 w-3.5" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
