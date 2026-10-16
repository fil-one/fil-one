import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { SearchInput } from './SearchInput';

/** Holds the value, as each toolbar does, so clearing is observable. */
function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <SearchInput
      value={value}
      onChange={setValue}
      placeholder="Search things"
      aria-label="Search things"
    />
  );
}

describe('SearchInput', () => {
  it('offers no clear button while the field is empty', () => {
    render(<Harness initial="" />);

    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
  });

  it('empties the field and puts focus back in it when Clear search is clicked', () => {
    render(<Harness initial="any-query" />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    const field = screen.getByRole('searchbox', { name: 'Search things' });
    expect({
      value: (field as HTMLInputElement).value,
      focused: document.activeElement === field,
    }).toStrictEqual({ value: '', focused: true });
  });

  it('drops the clear button once the field is cleared', () => {
    render(<Harness initial="any-query" />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
  });
});
