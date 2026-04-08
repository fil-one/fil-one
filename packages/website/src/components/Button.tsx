import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';

const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-[13px] font-medium transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-brand-800 text-white shadow-sm hover:bg-brand-800/90 active:bg-brand-800/95',
        destructive: 'bg-red-600 text-white shadow-sm hover:bg-red-600/90',
        outline: 'border border-zinc-200 bg-white shadow-xs hover:bg-zinc-50 hover:text-zinc-950',
        secondary: 'bg-zinc-100 text-zinc-900 shadow-xs hover:bg-zinc-100/80',
        ghost: 'hover:bg-zinc-100 hover:text-zinc-900',
        link: 'text-brand-800 underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-[12px]',
        lg: 'h-10 rounded-md px-6',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={clsx(buttonVariants({ variant, size, className }))} {...props} />;
}

export { buttonVariants };
