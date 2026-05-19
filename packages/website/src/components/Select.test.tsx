import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Select } from './Select';

describe('Select', () => {
  it('renders options', () => {
    render(
      <Select onChange={() => {}}>
        <option value="us-east-1">us-east-1</option>
        <option value="eu-west-1">eu-west-1</option>
      </Select>,
    );
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'eu-west-1' })).toBeInTheDocument();
  });

  it('calls onChange with the selected value', () => {
    const onChange = vi.fn();
    render(
      <Select onChange={onChange}>
        <option value="us-east-1">us-east-1</option>
        <option value="eu-west-1">eu-west-1</option>
      </Select>,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'eu-west-1' } });
    expect(onChange).toHaveBeenCalledWith('eu-west-1');
  });

  it('forwards the disabled prop', () => {
    render(
      <Select onChange={() => {}} disabled>
        <option value="a">a</option>
      </Select>,
    );
    expect(screen.getByRole('combobox')).toBeDisabled();
  });

  it('sets aria-invalid when invalid is true', () => {
    render(
      <Select onChange={() => {}} invalid>
        <option value="a">a</option>
      </Select>,
    );
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-invalid', 'true');
  });
});
