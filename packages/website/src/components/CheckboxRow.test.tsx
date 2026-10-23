import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { CheckboxRow } from './CheckboxRow.js';

describe('CheckboxRow', () => {
  it('toggles once when the row text is clicked', () => {
    const onChange = vi.fn();
    render(
      <CheckboxRow
        testId="row"
        label="Read objects"
        description="Get"
        checked={false}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByText('Read objects'));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ignores a click on a disabled row', () => {
    const onChange = vi.fn();
    render(
      <CheckboxRow
        testId="row"
        label="Read objects"
        description="Get"
        checked
        disabled
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByText('Read objects'));

    expect(onChange).not.toHaveBeenCalled();
  });
});
