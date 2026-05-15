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
            <li key={item.href ?? item.label} className="flex items-center gap-2">
              {index > 0 && (
                <span aria-hidden="true" className="text-zinc-400 select-none">
                  /
                </span>
              )}
              {item.href && !isLast ? (
                <BaseLink
                  href={item.href}
                  className={clsx(
                    'text-zinc-600 transition-colors hover:text-brand-700',
                    'hover:underline',
                  )}
                >
                  {item.label}
                </BaseLink>
              ) : (
                <span
                  className={clsx(isLast ? 'font-medium text-zinc-950' : 'text-zinc-600')}
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
