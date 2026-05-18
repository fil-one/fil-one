import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ObjectSettingsFields } from './ObjectSettingsFields';

function renderWithDefaults(overrides: Partial<Parameters<typeof ObjectSettingsFields>[0]> = {}) {
  const props = {
    versioning: false,
    onVersioningChange: vi.fn(),
    lock: false,
    onLockChange: vi.fn(),
    retentionEnabled: false,
    onRetentionEnabledChange: vi.fn(),
    retentionMode: 'governance' as const,
    onRetentionModeChange: vi.fn(),
    retentionDuration: 15,
    onRetentionDurationChange: vi.fn(),
    retentionDurationType: 'd' as const,
    onRetentionDurationTypeChange: vi.fn(),
    ...overrides,
  };
  render(<ObjectSettingsFields {...props} />);
  return props;
}

describe('ObjectSettingsFields', () => {
  it('renders all three toggle rows', () => {
    renderWithDefaults();
    expect(screen.getByText('Versioning')).toBeInTheDocument();
    expect(screen.getByText('Object Lock')).toBeInTheDocument();
    expect(screen.getByText('Retention')).toBeInTheDocument();
  });

  it('renders three switch toggles', () => {
    renderWithDefaults();
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(3);
  });

  it('disables Object Lock and Retention switches when versioning is off', () => {
    renderWithDefaults({ versioning: false });
    const switches = screen.getAllByRole('switch');
    // Object Lock switch (index 1)
    expect(switches[1]).toHaveAttribute('aria-checked', 'false');
    expect(switches[1]).toBeDisabled();
    // Retention switch (index 2)
    expect(switches[2]).toHaveAttribute('aria-checked', 'false');
    expect(switches[2]).toBeDisabled();
  });

  it('enables Object Lock switch when versioning is on', () => {
    renderWithDefaults({ versioning: true });
    const switches = screen.getAllByRole('switch');
    expect(switches[1]).not.toBeDisabled();
  });

  it('disables Retention switch when Object Lock is off', () => {
    renderWithDefaults({ versioning: true, lock: false });
    const switches = screen.getAllByRole('switch');
    expect(switches[2]).toBeDisabled();
  });

  it('enables Retention switch when Object Lock is on', () => {
    renderWithDefaults({ versioning: true, lock: true });
    const switches = screen.getAllByRole('switch');
    expect(switches[2]).not.toBeDisabled();
  });

  it('cascades versioning off to lock and retention', () => {
    const props = renderWithDefaults({ versioning: true, lock: true, retentionEnabled: true });
    // Toggle versioning off
    fireEvent.click(screen.getAllByRole('switch')[0]);
    expect(props.onVersioningChange).toHaveBeenCalledWith(false);
    expect(props.onLockChange).toHaveBeenCalledWith(false);
    expect(props.onRetentionEnabledChange).toHaveBeenCalledWith(false);
  });

  it('cascades lock off to retention', () => {
    const props = renderWithDefaults({ versioning: true, lock: true, retentionEnabled: true });
    // Toggle lock off
    fireEvent.click(screen.getAllByRole('switch')[1]);
    expect(props.onLockChange).toHaveBeenCalledWith(false);
    expect(props.onRetentionEnabledChange).toHaveBeenCalledWith(false);
  });

  it('does not show retention details when retention is disabled', () => {
    renderWithDefaults({ versioning: true, lock: true, retentionEnabled: false });
    expect(screen.queryByText('Default Retention Policy')).not.toBeInTheDocument();
  });

  it('shows retention details when retention is enabled', () => {
    renderWithDefaults({ versioning: true, lock: true, retentionEnabled: true });
    expect(screen.getByText('Default Retention Policy')).toBeInTheDocument();
    expect(screen.getByText('Governance')).toBeInTheDocument();
    expect(screen.getByText('Compliance')).toBeInTheDocument();
    expect(screen.getByText('Lock period')).toBeInTheDocument();
  });

  it('switches retention mode via radio buttons', () => {
    const props = renderWithDefaults({
      versioning: true,
      lock: true,
      retentionEnabled: true,
      retentionMode: 'governance',
    });
    fireEvent.click(screen.getByLabelText(/Compliance/));
    expect(props.onRetentionModeChange).toHaveBeenCalledWith('compliance');
  });

  it('shows duration input with current value', () => {
    renderWithDefaults({
      versioning: true,
      lock: true,
      retentionEnabled: true,
      retentionDuration: 15,
    });
    const input = screen.getByRole('spinbutton');
    expect(input).toHaveValue(15);
  });

  it('shows duration type dropdown with Days and Years options', () => {
    renderWithDefaults({ versioning: true, lock: true, retentionEnabled: true });
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
    expect(screen.getByText('Days')).toBeInTheDocument();
    expect(screen.getByText('Years')).toBeInTheDocument();
  });
});
