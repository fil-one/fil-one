import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { CopyableField } from './CopyableField';

// Mock the toast provider used by useCopyToClipboard
vi.mock('../../components/Toast/index.js', () => ({
  useToast: () => ({ toast: { error: vi.fn() } }),
}));

// Mock clipboard API
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

describe('CopyableField', () => {
  it('renders label and value', () => {
    render(<CopyableField label="Endpoint" value="https://s3.fil.one" />);
    expect(screen.getByText('Endpoint')).toBeInTheDocument();
    expect(screen.getByText('https://s3.fil.one')).toBeInTheDocument();
  });

  it('has a copy button with accessible label', () => {
    render(<CopyableField label="Endpoint" value="https://s3.fil.one" />);
    expect(screen.getByRole('button', { name: 'Copy Endpoint' })).toBeInTheDocument();
  });

  it('copies value to clipboard on click', () => {
    render(<CopyableField label="Endpoint" value="https://s3.fil.one" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Endpoint' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://s3.fil.one');
  });

  it('accepts className prop', () => {
    const { container } = render(
      <CopyableField label="Endpoint" value="https://s3.fil.one" className="mt-4" />,
    );
    expect(container.firstChild).toHaveClass('mt-4');
  });
});
