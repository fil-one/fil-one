import { Button } from '../Button/index.js';
import { Heading, type HeadingProps } from '../Heading/index.js';
import { IconBadge } from '../IconBadge/index.js';
import type { IconBadgeProps } from '../IconBadge/index.js';
import { StateCard } from '../StateCard/index.js';

export type EmptyStateCardAction = {
  label: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  href?: string;
};

export type EmptyStateCardProps = {
  icon: IconBadgeProps['icon'];
  title: HeadingProps['children'];
  titleTag: HeadingProps['tag'];
  description: string;
  /** Primary CTA rendered as a branded Button. Use `children` for anything more complex. */
  action?: EmptyStateCardAction;
  children?: React.ReactNode;
  className?: string;
};

export function EmptyStateCard({
  icon,
  title,
  titleTag,
  description,
  action,
  children,
  className,
}: EmptyStateCardProps) {
  const cta = action ? (
    action.href ? (
      <Button asChild size="sm">
        <a href={action.href}>{action.label}</a>
      </Button>
    ) : (
      <Button size="sm" onClick={action.onClick}>
        {action.label}
      </Button>
    )
  ) : null;

  return (
    <StateCard border="dashed" className={className}>
      <div className="flex w-full flex-col items-center justify-center gap-3">
        <IconBadge icon={icon} variant="brand" size="md" />

        <div className="space-y-1 text-center">
          <Heading tag={titleTag} size="sm" balance>
            {title}
          </Heading>
          <p className="text-xs text-zinc-500">{description}</p>
        </div>

        {cta}
        {children}
      </div>
    </StateCard>
  );
}
