import { CaretDownIcon } from '@phosphor-icons/react/dist/ssr';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import clsx from 'clsx';

import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import type { ComponentType, SVGProps } from 'react';

import type { ButtonSize } from './Button.js';
import { Icon } from './Icon.js';

export type SplitButtonItem = {
  label: string;
  icon?: PhosphorIcon | ComponentType<SVGProps<SVGSVGElement>>;
  onClick: () => void;
};

export type SplitButtonVariant = 'primary' | 'ghost';

type SplitButtonProps = {
  label: string;
  icon?: PhosphorIcon | ComponentType<SVGProps<SVGSVGElement>>;
  onMainClick: () => void;
  items: SplitButtonItem[];
  variant?: SplitButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
};

const iconSizes: Record<ButtonSize, number> = {
  sm: 14,
  md: 16,
  lg: 18,
};

export function SplitButton({
  label,
  icon: IconComp,
  onMainClick,
  items,
  variant = 'primary',
  size = 'md',
  disabled,
}: SplitButtonProps) {
  const iconSize = iconSizes[size];

  return (
    <div
      className={clsx(
        'split-button',
        `split-button--${variant}`,
        `split-button--${size}`,
        disabled && 'split-button--disabled',
      )}
    >
      <button
        type="button"
        className="split-button__main"
        onClick={onMainClick}
        disabled={disabled}
      >
        {IconComp && <Icon component={IconComp} size={iconSize} />}
        <span>{label}</span>
      </button>

      <div className="split-button__divider" aria-hidden="true" />

      <Menu as="div" className="relative flex items-stretch">
        <MenuButton
          as="button"
          type="button"
          className="split-button__caret"
          disabled={disabled}
          aria-label="More download options"
        >
          <Icon component={CaretDownIcon} size={iconSize} />
        </MenuButton>
        <MenuItems className="split-button__menu">
          {items.map((item) => (
            <MenuItem key={item.label}>
              <button type="button" onClick={item.onClick} className="split-button__item">
                {item.icon && <Icon component={item.icon} size={14} />}
                <span>{item.label}</span>
              </button>
            </MenuItem>
          ))}
        </MenuItems>
      </Menu>
    </div>
  );
}
