import type { AnchorHTMLAttributes } from 'react';

import { Link } from '@tanstack/react-router';

import { useOrgPath } from '../lib/use-org-path.js';

export type BaseLinkProps = {
  href: string;
  children?: React.ReactNode;
  className?: string;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>;

function isInternalLink(href: string): boolean {
  return href.startsWith('/') || href.startsWith('#');
}

/**
 * Every internal `href` that starts with `/` is prefixed with the active
 * org's slug, unless it names one of `useOrgPath`'s unscoped routes — so the
 * ~15+ page files that build a plain `href="/buckets"` (or similar) need no
 * changes of their own to land in the right org.
 */
export function BaseLink({ href, children, ...rest }: BaseLinkProps) {
  const orgPath = useOrgPath();

  if (href.startsWith('mailto:')) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }

  if (isInternalLink(href)) {
    return (
      <Link to={href.startsWith('/') ? orgPath(href) : href} {...rest}>
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
