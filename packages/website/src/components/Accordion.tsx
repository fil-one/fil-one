import { Disclosure, DisclosureButton, DisclosurePanel } from '@headlessui/react';
import { CaretDownIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';

export type AccordionItem = {
  title: string;
  content: React.ReactNode;
};

type AccordionProps = {
  items: AccordionItem[];
  className?: string;
};

/**
 * A list of questions or sections, each opening on its own to show its content.
 *
 * Built on Headless UI's `Disclosure`, which gives each button `aria-expanded`
 * and `aria-controls` and toggles on Enter and Space. Items open independently,
 * so a reader comparing two answers can keep both open.
 *
 * `text-pretty` on questions and answers keeps a paragraph from ending on a
 * single word.
 *
 * Hairlines rather than a card: it usually sits under a form that already is
 * one, and a second box below it competes with the form.
 */
export function Accordion({ items, className }: AccordionProps) {
  return (
    <div className={clsx('divide-y divide-zinc-200/60 border-y border-zinc-200/60', className)}>
      {items.map((item) => (
        <Disclosure key={item.title} as="div" className="py-1">
          {/* The button reaches 8px past the text on each side, so the focus
              ring has room around the question while the question itself
              stays aligned with the heading above. Hover is colour only: a
              fill would overhang the hairlines by those same 8px. */}
          <DisclosureButton className="group -mx-2 flex w-[calc(100%+1rem)] items-start justify-between gap-4 rounded-md px-2 py-2.5 text-left text-ui font-medium text-pretty text-zinc-700 transition-colors duration-150 hover:text-zinc-900 focus-visible:brand-outline data-open:text-zinc-900">
            {item.title}
            {/* Sits on the first line of a question that wraps: centred, it
                would float between the lines and belong to neither. */}
            <CaretDownIcon
              size={14}
              aria-hidden="true"
              className="mt-0.75 shrink-0 text-zinc-400 transition duration-200 group-hover:text-zinc-600 group-data-open:rotate-180"
            />
          </DisclosureButton>
          {/* Fades in on open and leaves at once on close. A closing fade
              holds the answer's full height until it ends, then the rows
              below jump up, which reads as a stall. */}
          <DisclosurePanel
            transition
            className="pt-0.5 pr-8 pb-3 text-ui leading-relaxed text-pretty text-zinc-500 transition duration-150 ease-out data-closed:-translate-y-1 data-closed:opacity-0 data-leave:duration-0"
          >
            {item.content}
          </DisclosurePanel>
        </Disclosure>
      ))}
    </div>
  );
}
