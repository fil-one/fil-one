import { type ComponentPropsWithoutRef, type ElementType, forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utils.js';

type HeadingTag = Extract<ElementType, 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'>;

export const headingVariants = cva('text-zinc-900', {
  variants: {
    size: {
      /** Subsection labels — text-sm font-medium */
      sm: 'text-sm font-medium',
      /** Dashboard / section headers — text-lg font-medium */
      lg: 'text-lg font-medium',
      /** Sub-page titles — text-xl font-medium tracking-tight */
      xl: 'text-xl font-medium tracking-tight',
      /** Main page titles — text-2xl font-medium */
      '2xl': 'text-2xl font-medium',
      /** Large display headings (auth pages) — text-3xl font-medium */
      '3xl': 'text-3xl font-medium',
    },
    balance: {
      true: 'text-balance',
    },
  },
  defaultVariants: {
    size: 'xl',
    balance: false,
  },
});

export type HeadingProps<T extends HeadingTag = HeadingTag> = {
  /** The HTML heading element to render (h1–h6). */
  tag: T;
  /** Optional description rendered as a paragraph below the heading. */
  description?: string;
  children: React.ReactNode;
  className?: string;
} & VariantProps<typeof headingVariants> &
  Omit<ComponentPropsWithoutRef<T>, 'children' | 'className'>;

export const Heading = forwardRef<HTMLHeadingElement, HeadingProps>(
  ({ tag: Tag, size, balance, description, className, children, ...rest }, ref) => {
    const heading = (
      <Tag ref={ref} {...rest} className={cn(headingVariants({ size, balance }), className)}>
        {children}
      </Tag>
    );

    if (!description) return heading;

    return (
      <div className="flex flex-col gap-1">
        {heading}
        <p className="text-sm text-zinc-500">{description}</p>
      </div>
    );
  },
);
Heading.displayName = 'Heading';
