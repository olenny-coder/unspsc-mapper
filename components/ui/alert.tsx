import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Alerts.
 *
 * The coloured variants carry *meaning*, so they cannot simply use the neutral
 * semantic tokens — but they must stay legible on both surfaces. Each variant is
 * therefore declared twice: a light treatment and a `dark:` treatment using a
 * deep tinted background with a light foreground.
 *
 * `break-words` and `min-w-0` are load-bearing rather than cosmetic. Alert bodies
 * routinely quote identifiers — environment variable names, API error messages,
 * URLs — and a long unbroken token cannot wrap, so it overflows the box instead of
 * moving to the next line. `break-words` lets it break; `min-w-0` stops a parent
 * flex or grid container from being widened by the token's intrinsic width. Both
 * are set here, once, so an alert added later cannot reintroduce the bug.
 */
const alertVariants = cva(
  'relative w-full min-w-0 break-words rounded-lg border p-3 text-sm sm:p-4 [&>svg]:absolute [&>svg]:left-3 [&>svg]:top-3.5 [&>svg]:h-4 [&>svg]:w-4 sm:[&>svg]:left-4 sm:[&>svg]:top-4 [&>svg~*]:pl-7',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground',
        destructive:
          'border-destructive/40 bg-destructive/10 text-destructive dark:border-destructive/50 dark:bg-destructive/15 dark:text-red-300 [&>svg]:text-destructive dark:[&>svg]:text-red-400',
        warning:
          'border-amber-300 bg-amber-50 text-amber-900 [&>svg]:text-amber-600 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200 dark:[&>svg]:text-amber-400',
        success:
          'border-emerald-300 bg-emerald-50 text-emerald-900 [&>svg]:text-emerald-600 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200 dark:[&>svg]:text-emerald-400',
        info: 'border-sky-300 bg-sky-50 text-sky-900 [&>svg]:text-sky-600 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200 dark:[&>svg]:text-sky-400',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
));
Alert.displayName = 'Alert';

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5 ref={ref} className={cn('mb-1 font-medium leading-none tracking-tight', className)} {...props} />
  ),
);
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('text-sm [&_p]:leading-relaxed', className)} {...props} />
  ),
);
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription, alertVariants };
