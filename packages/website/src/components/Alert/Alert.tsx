import {
  InfoIcon,
  WarningCircleIcon,
  CheckCircleIcon,
  WarningIcon,
} from '@phosphor-icons/react/dist/ssr';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';
import { IconBadge } from '../IconBadge/index.js';

const alertVariants = cva('flex items-start gap-3 rounded-2xl border p-5', {
  variants: {
    variant: {
      info: 'border-zinc-200 bg-zinc-100',
      success: 'border-green-200 bg-green-50',
      warning: 'border-amber-200 bg-amber-50',
      error: 'border-red-200 bg-red-50',
    },
  },
  defaultVariants: { variant: 'info' },
});

const iconMap = {
  info: InfoIcon,
  success: CheckCircleIcon,
  warning: WarningIcon,
  error: WarningCircleIcon,
} as const;

export type AlertProps = {
  title: string;
  description?: ReactNode;
  variant?: NonNullable<VariantProps<typeof alertVariants>['variant']>;
  className?: string;
};

export function Alert({ title, description, variant = 'info', className }: AlertProps) {
  return (
    <div className={cn(alertVariants({ variant }), className)} role="alert">
      <IconBadge icon={iconMap[variant]} variant={variant} />

      <div className="flex flex-1 flex-col gap-2">
        <span className="font-medium text-zinc-950">{title}</span>
        {description && <span className="text-sm text-zinc-600">{description}</span>}
      </div>
    </div>
  );
}

export { alertVariants };
