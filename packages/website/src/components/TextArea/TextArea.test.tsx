import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TextArea } from './TextArea';

describe('TextArea', () => {
  it('renders with placeholder', () => {
    render(<TextArea placeholder="Enter message" />);
    expect(screen.getByPlaceholderText('Enter message')).toBeInTheDocument();
  });

  it('calls onChange with the event', () => {
    const onChange = vi.fn();
    render(<TextArea onChange={onChange} placeholder="test" />);
    fireEvent.change(screen.getByPlaceholderText('test'), { target: { value: 'hello' } });
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0].target.value).toBe('hello');
  });

  it('supports disabled state', () => {
    render(<TextArea placeholder="disabled" disabled />);
    expect(screen.getByPlaceholderText('disabled')).toBeDisabled();
  });

  it('forwards ref to the textarea element', () => {
    const ref = { current: null as HTMLTextAreaElement | null };
    render(<TextArea ref={ref} placeholder="ref test" />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
  });

  it('merges className', () => {
    render(<TextArea placeholder="cls" className="custom-class" />);
    expect(screen.getByPlaceholderText('cls')).toHaveClass('custom-class');
  });
});
