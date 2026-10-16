import { clsx } from 'clsx';

import { Overline } from './Overline';

export type InfoAsideItem = {
  title: string;
  description: React.ReactNode;
};

type InfoAsideProps = {
  title: string;
  items: InfoAsideItem[];
  className?: string;
};

/** Sticky column of short notes that sits beside a create form. */
export function InfoAside({ title, items, className }: InfoAsideProps) {
  return (
    <aside className={clsx('sticky top-0 w-60 shrink-0 self-start pt-1', className)}>
      <Overline>{title}</Overline>

      <div className="mt-3 flex flex-col">
        {items.map((item, index) => (
          <div
            key={item.title}
            className={clsx(
              'flex flex-col gap-0.5 py-3',
              index > 0 && 'border-t border-zinc-200/60',
            )}
          >
            <span className="text-sm font-medium text-zinc-900">{item.title}</span>
            <p className="text-xs leading-relaxed text-zinc-500">{item.description}</p>
          </div>
        ))}
      </div>
    </aside>
  );
}
