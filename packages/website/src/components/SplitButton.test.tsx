import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SplitButton } from './SplitButton';

describe('SplitButton', () => {
  beforeAll(() => {
    // Headless UI's anchor-positioned MenuItems uses ResizeObserver,
    // which JSDOM doesn't provide.
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('renders the main label', () => {
    render(<SplitButton label="Download .csv" onMainClick={() => {}} items={[]} />);
    expect(screen.getByText('Download .csv')).toBeInTheDocument();
  });

  it('calls onMainClick when the main button is clicked', () => {
    const onMainClick = vi.fn();
    render(<SplitButton label="Download .csv" onMainClick={onMainClick} items={[]} />);
    fireEvent.click(screen.getByText('Download .csv'));
    expect(onMainClick).toHaveBeenCalledOnce();
  });

  it('renders menu items in the portal when the caret is clicked', () => {
    render(
      <SplitButton
        label="Download .csv"
        onMainClick={() => {}}
        items={[{ label: 'Download .env', onClick: () => {} }]}
      />,
    );
    fireEvent.click(screen.getByLabelText('More download options'));
    expect(screen.getByText('Download .env')).toBeInTheDocument();
  });

  it("calls the item's onClick when a menu item is clicked", () => {
    const onItemClick = vi.fn();
    render(
      <SplitButton
        label="Download .csv"
        onMainClick={() => {}}
        items={[{ label: 'Download .env', onClick: onItemClick }]}
      />,
    );
    fireEvent.click(screen.getByLabelText('More download options'));
    fireEvent.click(screen.getByText('Download .env'));
    expect(onItemClick).toHaveBeenCalledOnce();
  });

  it('disables both buttons when disabled', () => {
    render(<SplitButton label="Download .csv" onMainClick={() => {}} items={[]} disabled />);
    expect(screen.getByText('Download .csv').closest('button')).toBeDisabled();
    expect(screen.getByLabelText('More download options')).toBeDisabled();
  });
});
