import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';

import { BaseLink, type BaseLinkProps } from './BaseLink';
import { Icon as IconComponent, type IconProps } from './Icon';

export type ButtonVariant = 'primary' | 'ghost' | 'tertiary' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';
export type ButtonIconPosition = 'left' | 'right';

export type ButtonProps = {
  variant: ButtonVariant;
  icon?: IconProps['component'];
  iconPosition?: ButtonIconPosition;
  href?: BaseLinkProps['href'];
  size?: ButtonSize;
  children: React.ReactNode;
} & React.ComponentPropsWithoutRef<'button'>;

type ButtonInnerProps = Pick<ButtonProps, 'children' | 'icon' | 'iconPosition' | 'size'> & {
  isExternalLink?: boolean;
};

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'button--primary',
  ghost: 'button--ghost',
  tertiary: 'button--tertiary',
  destructive: 'button--destructive',
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
  children,
  disabled,
  href,
  size = 'md',
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
      <button className={classes} disabled={disabled} {...rest}>
        <ButtonInner icon={icon} iconPosition={iconPosition} size={size}>
          {children}
        </ButtonInner>
      </button>
    );
  }

  return (
    <BaseLink className={classes} href={href}>
      <ButtonInner
        isExternalLink={isExternalHref(href)}
        icon={icon}
        iconPosition={iconPosition}
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
  children,
  isExternalLink,
  size = 'md',
}: ButtonInnerProps) {
  const iconSize = iconSizes[size];
  const iconEl = Icon && (
    <span className="button-custom-icon">
      <IconComponent component={Icon} size={iconSize} />
    </span>
  );

  return (
    <>
      {iconPosition === 'left' && iconEl}
      <span>{children}</span>
      {iconPosition === 'right' && iconEl}
      {isExternalLink && (
        <span className="button-arrow-icon">
          <IconComponent component={ArrowUpRightIcon} size={iconSize} />
        </span>
      )}
    </>
  );
}
