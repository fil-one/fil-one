import { clsx } from 'clsx';

export type CardPadding = 'none' | 'md';

type CardProps = {
  children: React.ReactNode;
  shadow?: boolean;
  padding?: CardPadding;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>;

const paddingStyles: Record<CardPadding, string> = {
  none: '',
  md: 'p-5',
};

export function Card({ children, shadow, padding = 'md', className, ...rest }: CardProps) {
  return (
    <div
      className={clsx(
        'rounded-xl border border-zinc-200 bg-white',
        paddingStyles[padding],
        shadow && 'shadow-xs',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
