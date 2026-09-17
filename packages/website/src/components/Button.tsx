import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/ssr';
import type { AnchorHTMLAttributes } from 'react';
import { clsx } from 'clsx';

import { BaseLink, type BaseLinkProps } from './BaseLink';
import { Icon as IconComponent, type IconProps } from './Icon';

export type ButtonVariant = 'primary' | 'ghost' | 'tertiary' | 'destructive' | 'warning';
export type ButtonSize = 'sm' | 'md' | 'lg';
export type ButtonIconPosition = 'left' | 'right';

export type ButtonProps = {
  variant: ButtonVariant;
  icon?: IconProps['component'];
  iconPosition?: ButtonIconPosition;
  /** Overrides the size-derived icon size (px) when a glyph needs more presence. */
  iconSize?: number;
  href?: BaseLinkProps['href'];
  /**
   * Whether an external `href` gets the trailing arrow that marks a trip out of
   * the console. On by default, and turned off for a link that is not a
   * navigation: a download opens a file rather than taking you somewhere, so the
   * arrow would be describing the wrong thing.
   */
  externalIcon?: boolean;
  size?: ButtonSize;
  children: React.ReactNode;
} & React.ComponentPropsWithoutRef<'button'>;

type ButtonInnerProps = Pick<
  ButtonProps,
  'children' | 'icon' | 'iconPosition' | 'iconSize' | 'size'
> & {
  isExternalLink?: boolean;
};

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'button--primary',
  ghost: 'button--ghost',
  tertiary: 'button--tertiary',
  destructive: 'button--destructive',
  warning: 'button--warning',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'button--sm',
  md: 'button--md',
  lg: 'button--lg',
};

const iconSizes: Record<ButtonSize, number> = {
  sm: 14,
  md: 16,
  lg: 18,
};

function isExternalHref(href: string): boolean {
  return !href.startsWith('/') && !href.startsWith('#') && !href.startsWith('mailto:');
}

export function Button({
  variant,
  className,
  icon,
  iconPosition = 'left',
  iconSize,
  children,
  disabled,
  href,
  externalIcon = true,
  size = 'md',
  id,
  ...rest
}: ButtonProps) {
  const classes = clsx(
    'button',
    variantClasses[variant],
    sizeClasses[size],
    icon && iconPosition === 'left' && 'button--icon-left',
    icon && iconPosition === 'right' && 'button--icon-right',
    className,
  );

  if (typeof href === 'undefined' || disabled) {
    return (
      <button id={id} className={classes} disabled={disabled} {...rest}>
        <ButtonInner icon={icon} iconPosition={iconPosition} iconSize={iconSize} size={size}>
          {children}
        </ButtonInner>
      </button>
    );
  }

  // `rest` reaches the anchor too: without it a link button silently dropped
  // every attribute a caller passed, `aria-label` included, so a row of
  // identically-labelled links had nothing to tell them apart. The cast is the
  // element swap and nothing more — these props are typed against `button`
  // because that is what this component usually renders, and the handlers among
  // them differ only in the element their event carries.
  const linkProps = rest as AnchorHTMLAttributes<HTMLAnchorElement>;

  return (
    <BaseLink id={id} className={classes} href={href} {...linkProps}>
      <ButtonInner
        isExternalLink={externalIcon && isExternalHref(href)}
        icon={icon}
        iconPosition={iconPosition}
        iconSize={iconSize}
        size={size}
      >
        {children}
      </ButtonInner>
    </BaseLink>
  );
}

function ButtonInner({
  icon: Icon,
  iconPosition = 'left',
  iconSize,
  children,
  isExternalLink,
  size = 'md',
}: ButtonInnerProps) {
  const defaultIconSize = iconSizes[size];
  const iconEl = Icon && (
    <span className="button-custom-icon">
      <IconComponent component={Icon} size={iconSize ?? defaultIconSize} />
    </span>
  );

  return (
    <>
      {iconPosition === 'left' && iconEl}
      <span>{children}</span>
      {iconPosition === 'right' && iconEl}
      {isExternalLink && (
        <span className="button-arrow-icon">
          <IconComponent component={ArrowUpRightIcon} size={defaultIconSize} />
        </span>
      )}
    </>
  );
}
