import {
  CheckCircleIcon,
  InfoIcon,
  WarningCircleIcon,
  WarningIcon,
} from '@phosphor-icons/react/dist/ssr';
import clsx from 'clsx';

import type { IconBoxColor } from './IconBox.js';
import { IconBox } from './IconBox.js';

export type AlertVariant = 'blue' | 'green' | 'red' | 'grey' | 'amber';

export type AlertProps = {
  variant?: AlertVariant;
  title?: string;
  description: string;
};

const containerStyles: Record<AlertVariant, string> = {
  blue: 'border-brand-200 bg-brand-50',
  green: 'border-green-200 bg-green-50',
  red: 'border-red-200 bg-red-50',
  grey: 'border-zinc-200 bg-zinc-100',
  amber: 'border-amber-200 bg-amber-50',
};

const iconBoxColors: Record<AlertVariant, IconBoxColor> = {
  blue: 'blue',
  green: 'green',
  red: 'red',
  grey: 'grey',
  amber: 'amber',
};

const textStyles: Record<AlertVariant, string> = {
  blue: 'text-brand-900',
  green: 'text-green-900',
  red: 'text-red-900',
  grey: 'text-zinc-900',
  amber: 'text-amber-900',
};

const iconComponents: Record<AlertVariant, typeof InfoIcon> = {
  blue: InfoIcon,
  green: CheckCircleIcon,
  red: WarningCircleIcon,
  grey: InfoIcon,
  amber: WarningIcon,
};

export function Alert({ variant = 'blue', title, description }: AlertProps) {
  return (
    <div
      className={clsx('flex items-start gap-3 rounded-lg border p-3', containerStyles[variant])}
      role="alert"
    >
      <IconBox icon={iconComponents[variant]} color={iconBoxColors[variant]} size="sm" />
      <div className="flex flex-1 flex-col gap-1 pt-1">
        {title && <span className={clsx('text-sm font-medium', textStyles[variant])}>{title}</span>}
        <span className={clsx('text-xs leading-[18px]', textStyles[variant])}>{description}</span>
      </div>
    </div>
  );
}
