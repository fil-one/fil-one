import { clsx } from 'clsx';

import { cn } from '../lib/utils.js';
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

/**
 * Column of short notes beside a create form: stacked under the form below `xl`, a sticky column
 * beside it from `xl`. The page lays both out with `flex flex-col xl:flex-row`. `className` is
 * merged over the defaults, so a page that keeps the notes under its form at every width can
 * replace the `xl:` column classes.
 */
export function InfoAside({ title, items, className }: InfoAsideProps) {
  return (
    // xl:pt-5 lines the overline up with the card's first label, which sits under the card's p-5
    <aside
      className={cn(
        'w-full max-w-[520px] xl:sticky xl:top-0 xl:w-60 xl:shrink-0 xl:self-start xl:pt-5',
        className,
      )}
    >
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
            <span className="text-xs font-medium text-zinc-900">{item.title}</span>
            <p className="text-xs leading-relaxed text-pretty text-zinc-500">{item.description}</p>
          </div>
        ))}
      </div>
    </aside>
  );
}
