import { clsx } from 'clsx';

import { BaseLink } from './BaseLink';

export type BreadcrumbItem = {
  label: string;
  href?: string;
};

export type BreadcrumbProps = {
  items: BreadcrumbItem[];
  className?: string;
};

export function Breadcrumb({ items, className }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-2 text-sm">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;

          return (
            // The current page's crumb starts at zero width and grows into what is
            // left of the line, so a long last label (an object's file name)
            // truncates in place. It drops to a line of its own only when less
            // than min-w-16 is left, where it would show nothing but an ellipsis.
            <li
              key={item.href ?? item.label}
              className={clsx('flex items-center gap-2', isLast && 'max-w-full min-w-16 flex-1')}
            >
              {index > 0 && (
                <span aria-hidden="true" className="text-zinc-400 select-none">
                  /
                </span>
              )}
              {item.href && !isLast ? (
                <BaseLink
                  href={item.href}
                  // Linear-style: a crumb signals it's interactive by quietly
                  // darkening into the neutral family, not by switching to an
                  // accent colour and underline. The rest state is muted; hover
                  // brings it up to the same near-black the current page uses.
                  className="text-zinc-500 transition-colors hover:text-zinc-950"
                >
                  {item.label}
                </BaseLink>
              ) : (
                <span
                  className={clsx(
                    isLast ? 'min-w-0 truncate font-medium text-zinc-950' : 'text-zinc-600',
                  )}
                  title={isLast ? item.label : undefined}
                  aria-current={isLast ? 'page' : undefined}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
