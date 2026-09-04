import { Card } from './Card';
import { Heading } from './Heading/Heading.js';

/**
 * A titled card for a settings-style page: the heading sits above the card
 * rather than inside it, the way Settings and Edit organization both lay out
 * their sections.
 */
export function SectionCard({
  title,
  bare,
  children,
}: {
  title: string;
  /** Skips `Card`'s own padding, for a section that manages its own to keep its edges symmetric. */
  bare?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Heading tag="h2" size="sm">
        {title}
      </Heading>
      <Card padding={bare ? 'none' : 'md'}>{children}</Card>
    </div>
  );
}
