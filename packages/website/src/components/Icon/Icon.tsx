import type { ComponentType, SVGProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import type { Icon as PhosphorIcon, IconWeight } from '@phosphor-icons/react';

const sizeMap = {
  sm: 16,
  md: 20,
  lg: 24,
} as const;

export const iconVariants = cva('', {
  variants: {
    color: {
      inherit: '',
      success: 'text-(--color-icon-success)',
    },
  },
  defaultVariants: {
    color: 'inherit',
  },
});

export type IconProps = {
  component: PhosphorIcon | ComponentType<SVGProps<SVGSVGElement>>;
  size?: keyof typeof sizeMap;
  weight?: IconWeight;
} & VariantProps<typeof iconVariants>;

export function Icon({
  component: Component,
  color = 'inherit',
  size = 'lg',
  weight = 'regular',
}: IconProps) {
  const px = sizeMap[size];

  return (
    <span aria-hidden="true" className={iconVariants({ color })}>
      <Component weight={weight} width={px} height={px} />
    </span>
  );
}
