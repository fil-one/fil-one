import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Input } from './Input';

describe('Input', () => {
  it('renders with placeholder', () => {
    render(<Input placeholder="Enter text" />);
    expect(screen.getByPlaceholderText('Enter text')).toBeInTheDocument();
  });

  it('calls onChange with the event', () => {
    const onChange = vi.fn();
    render(<Input onChange={onChange} placeholder="test" />);
    fireEvent.change(screen.getByPlaceholderText('test'), { target: { value: 'hello' } });
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][0].target.value).toBe('hello');
  });

  it('supports disabled state', () => {
    render(<Input disabled placeholder="test" />);
    expect(screen.getByPlaceholderText('test')).toBeDisabled();
  });

  it('forwards ref to the input element', () => {
    const ref = vi.fn();
    render(<Input ref={ref} placeholder="test" />);
    expect(ref).toHaveBeenCalledWith(expect.any(HTMLInputElement));
  });

  it('merges className', () => {
    render(<Input className="custom-class" placeholder="test" />);
    expect(screen.getByPlaceholderText('test')).toHaveClass('custom-class');
  });
});
