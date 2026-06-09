import { clsx } from 'clsx';

export type CardPadding = 'none' | 'md';
export type CardColor = 'white' | 'subtle';

type CardProps = {
  children: React.ReactNode;
  shadow?: boolean;
  padding?: CardPadding;
  color?: CardColor;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>;

const paddingStyles: Record<CardPadding, string> = {
  none: '',
  md: 'p-5',
};

const colorStyles: Record<CardColor, string> = {
  white: 'bg-white',
  subtle: 'bg-zinc-50',
};

export function Card({
  children,
  shadow = true,
  padding = 'md',
  color = 'white',
  className,
  ...rest
}: CardProps) {
  return (
    <div
      className={clsx(
        'rounded-xl border border-zinc-200',
        colorStyles[color],
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
