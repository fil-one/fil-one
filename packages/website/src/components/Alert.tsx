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
  description?: string;
  showIcon?: boolean;
  centered?: boolean;
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
  grey: 'text-zinc-600',
  amber: 'text-amber-900',
};

const iconComponents: Record<AlertVariant, typeof InfoIcon> = {
  blue: InfoIcon,
  green: CheckCircleIcon,
  red: WarningCircleIcon,
  grey: InfoIcon,
  amber: WarningIcon,
};

export function Alert({
  variant = 'blue',
  title,
  description,
  showIcon = true,
  centered = false,
}: AlertProps) {
  return (
    <div
      className={clsx(
        'flex gap-3 rounded-lg border p-3',
        // Icon centres against the text block in both layouts, which keeps a
        // one-line and a two-line alert equally balanced. `centered` now only
        // controls horizontal centring.
        'items-center',
        centered && 'justify-center',
        containerStyles[variant],
      )}
      role="alert"
    >
      {/* `md` (18px glyph in a 38px box) rather than `sm` (14px in 26px): at sm the
          badge read as an undersized speck beside the text. Set here rather than
          exposed as a per-caller prop so every alert stays consistent. */}
      {showIcon && (
        <IconBox icon={iconComponents[variant]} color={iconBoxColors[variant]} size="md" />
      )}
      {/* No top offset: `pt-1` nudged the text down to sit against the icon box
          back when the row was top-aligned. The row now centres, so the offset
          would push the text off centre instead. */}
      <div className={clsx('flex flex-col gap-1', !centered && 'flex-1')}>
        {title && (
          <span
            className={clsx('text-sm font-medium', centered && 'text-center', textStyles[variant])}
          >
            {title}
          </span>
        )}
        {description && (
          <span
            className={clsx(
              'text-xs leading-[18px]',
              centered && 'text-center',
              textStyles[variant],
            )}
          >
            {description}
          </span>
        )}
      </div>
    </div>
  );
}
