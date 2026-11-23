import { describe, it, expect } from 'vitest';

import { cn } from './utils.js';

describe('cn', () => {
  it.each(['meta', 'ui'])('keeps a text colour alongside the custom text-%s size', (size) => {
    expect(cn('text-white', `text-${size}`)).toBe(`text-white text-${size}`);
  });

  it.each(['meta', 'ui'])('lets text-%s replace an earlier size', (size) => {
    expect(cn('text-xs', `text-${size}`)).toBe(`text-${size}`);
  });

  it('keeps an org monogram white at the size used in dense lists', () => {
    // UserAvatar's own grey, then OrgAvatar's white, then the `xs` size.
    expect(cn('text-zinc-800', 'bg-zinc-700 text-white', 'text-meta')).toBe(
      'bg-zinc-700 text-white text-meta',
    );
  });
});
