import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { Tooltip } from './Tooltip';

describe('Tooltip', () => {
  it('is hidden until the trigger is hovered', () => {
    render(
      <Tooltip content="Private bucket">
        <span>marker</span>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByText('marker').parentElement!);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Private bucket');
  });

  it('hides again on mouse leave', () => {
    render(
      <Tooltip content="Private bucket">
        <span>marker</span>
      </Tooltip>,
    );
    const trigger = screen.getByText('marker').parentElement!;

    fireEvent.mouseEnter(trigger);
    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Keyboard access
  // ---------------------------------------------------------------------------

  it('shows on focus, so the content is reachable without a pointer', () => {
    render(
      <Tooltip content="Deleting buckets is not available yet">
        <button type="button">Delete</button>
      </Tooltip>,
    );

    fireEvent.focus(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('hides on blur', () => {
    render(
      <Tooltip content="Deleting buckets is not available yet">
        <button type="button">Delete</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'Delete' });

    fireEvent.focus(button);
    fireEvent.blur(button);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('dismisses on Escape without moving focus', () => {
    render(
      <Tooltip content="Private bucket">
        <button type="button">Marker</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'Marker' });

    fireEvent.focus(button);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // focusable: for triggers that aren't focusable on their own
  // ---------------------------------------------------------------------------

  it('is not a tab stop by default', () => {
    render(
      <Tooltip content="Private bucket">
        <span>marker</span>
      </Tooltip>,
    );
    expect(screen.getByText('marker').parentElement).not.toHaveAttribute('tabindex');
  });

  it('becomes a labelled tab stop when focusable', () => {
    render(
      <Tooltip content="Private bucket" focusable>
        <span>marker</span>
      </Tooltip>,
    );
    const trigger = screen.getByRole('note', { name: 'Private bucket' });

    expect(trigger).toHaveAttribute('tabindex', '0');
    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Private bucket');
  });

  it('prefers an explicit label over the tooltip text', () => {
    render(
      <Tooltip content={<strong>Compliance</strong>} focusable label="Retention policy">
        <span>marker</span>
      </Tooltip>,
    );
    expect(screen.getByRole('note', { name: 'Retention policy' })).toBeInTheDocument();
  });
});
