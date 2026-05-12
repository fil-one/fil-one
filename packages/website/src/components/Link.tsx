import type { ComponentType, SVGProps } from 'react';

import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';

import { BaseLink, type BaseLinkProps } from './BaseLink';

export type LinkVariant = 'subtle' | 'accent';

export type LinkProps = {
  variant?: LinkVariant;
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  className?: string;
} & BaseLinkProps;

const variantClasses: Record<LinkVariant, string> = {
  subtle: 'text-zinc-500 hover:text-zinc-900',
  accent: 'text-brand-600 hover:underline',
};

function isExternal(href: string): boolean {
  return !href.startsWith('/') && !href.startsWith('#') && !href.startsWith('mailto:');
}

export function Link({
  variant = 'subtle',
  icon: Icon,
  className,
  children,
  href,
  ...rest
}: LinkProps) {
  const TrailingIcon = Icon ?? (isExternal(href) ? ArrowUpRightIcon : null);

  return (
    <BaseLink
      href={href}
      className={clsx(
        'inline-flex items-center gap-1 font-medium',
        variantClasses[variant],
        className,
      )}
      {...rest}
    >
      {children}
      {TrailingIcon && <TrailingIcon width={12} height={12} aria-hidden="true" />}
    </BaseLink>
  );
}
