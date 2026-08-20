import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Input } from './Input';

describe('Input', () => {
  it('renders with placeholder', () => {
    render(<Input aria-label="Text" onChange={() => {}} placeholder="Enter text" />);
    expect(screen.getByRole('textbox', { name: 'Text' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter text')).toBeInTheDocument();
  });

  it('takes its name from a label that points at its id', () => {
    render(
      <>
        <label htmlFor="email">Email address</label>
        <Input id="email" onChange={() => {}} />
      </>,
    );
    expect(screen.getByRole('textbox', { name: 'Email address' })).toBeInTheDocument();
  });

  it('calls onChange with value', () => {
    const onChange = vi.fn();
    render(<Input aria-label="Text" onChange={onChange} placeholder="test" />);
    fireEvent.change(screen.getByPlaceholderText('test'), { target: { value: 'hello' } });
    expect(onChange).toHaveBeenCalledWith('hello');
  });

  it('supports disabled state', () => {
    render(<Input aria-label="Text" onChange={() => {}} disabled placeholder="test" />);
    expect(screen.getByPlaceholderText('test')).toBeDisabled();
  });
});
