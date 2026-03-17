import type { AnchorHTMLAttributes } from 'react';

import { Link } from '@tanstack/react-router';

export type BaseLinkProps = {
  href: string;
  children?: React.ReactNode;
  className?: string;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>;

function isInternalLink(href: string): boolean {
  return href.startsWith('/') || href.startsWith('#');
}

export function BaseLink({ href, children, ...rest }: BaseLinkProps) {
  if (href.startsWith('mailto:')) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }

  if (isInternalLink(href)) {
    return (
      <Link to={href} {...rest}>
        {children}
      </Link>
    );
  }

  return (
    <a rel="noopener noreferrer" href={href} target="_blank" {...rest}>
      {children}
    </a>
  );
}
