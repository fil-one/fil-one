import { describe, it, expect, vi } from 'vitest';

import { warnIfUnnamedControl } from './accessible-control.js';

describe('warnIfUnnamedControl', () => {
  it('reports a control that rendered without a name', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    warnIfUnnamedControl('Input', undefined);

    expect(consoleSpy).toHaveBeenCalledWith(
      'Input rendered without an accessible name (see AccessibleControlName).',
    );

    consoleSpy.mockRestore();
  });

  it('stays quiet when a name is present', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    warnIfUnnamedControl('Input', 'Email address');

    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
