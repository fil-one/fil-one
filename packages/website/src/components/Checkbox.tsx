import {
  Checkbox as HeadlessCheckbox,
  type CheckboxProps as HeadlessCheckboxProps,
} from '@headlessui/react';
import { CheckIcon } from '@phosphor-icons/react/dist/ssr';
import clsx from 'clsx';

import { Icon } from './Icon';

type CheckboxProps = Omit<HeadlessCheckboxProps, 'children' | 'className'>;

export function Checkbox(props: CheckboxProps) {
  return (
    <HeadlessCheckbox
      {...props}
      className="group inline-block cursor-pointer p-3 -m-3 focus:outline-hidden"
    >
      <div
        className={clsx(
          'size-4 flex items-center justify-center rounded border border-zinc-300 bg-white p-0.5 text-white transition-colors',
          'group-data-checked:border-brand-600 group-data-checked:bg-brand-600',
          'hover:border-zinc-400 hover:bg-zinc-50',
          'group-data-checked:hover:border-brand-600 group-data-checked:hover:bg-brand-600',
          'group-focus:outline-2 group-focus:outline-offset-2 group-focus:outline-brand-600',
          'group-data-disabled:cursor-not-allowed group-data-disabled:opacity-50',
        )}
      >
        <span className="invisible group-data-checked:visible">
          <Icon component={CheckIcon} size={12} weight="bold" />
        </span>
      </div>
    </HeadlessCheckbox>
  );
}
