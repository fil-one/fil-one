import { clsx } from 'clsx';

export interface InputProps extends React.ComponentProps<'input'> {}

export function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={clsx(
        'flex h-9 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-[13px] text-zinc-900 transition-colors',
        'placeholder:text-zinc-400',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-1',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'file:border-0 file:bg-transparent file:text-[13px] file:font-medium',
        className,
      )}
      {...props}
    />
  );
}
