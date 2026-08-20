import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TextArea } from './TextArea';

describe('TextArea', () => {
  it('renders with placeholder', () => {
    render(<TextArea aria-label="Message" onChange={() => {}} placeholder="Enter message" />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter message')).toBeInTheDocument();
  });

  it('calls onChange with value', () => {
    const onChange = vi.fn();
    render(<TextArea aria-label="Message" onChange={onChange} placeholder="test" />);
    fireEvent.change(screen.getByPlaceholderText('test'), { target: { value: 'hello' } });
    expect(onChange).toHaveBeenCalledWith('hello');
  });
});
