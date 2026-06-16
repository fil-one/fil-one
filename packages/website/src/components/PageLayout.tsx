import { cn } from '../lib/utils.js';
import { Heading } from './Heading/Heading.js';

type PageLayoutProps = {
  title: React.ReactNode;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  maxWidth?: string;
  className?: string;
};

export function PageLayout({
  title,
  description,
  action,
  children,
  maxWidth,
  className,
}: PageLayoutProps) {
  return (
    <div
      className={cn(
        'px-5 pt-6 sm:px-8 lg:px-10 lg:pt-10',
        maxWidth && 'mx-auto',
        maxWidth,
        className,
      )}
    >
      <div className="mb-6 flex items-start justify-between gap-4">
        <Heading tag="h1" size="xl" description={description}>
          {title}
        </Heading>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </div>
  );
}
