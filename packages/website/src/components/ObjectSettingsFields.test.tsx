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
    expect(switches[1]).toHaveAttribute('aria-checked', 'false');
    expect(switches[1]).toBeDisabled();
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
    fireEvent.click(screen.getAllByRole('switch')[0]);
    expect(props.onVersioningChange).toHaveBeenCalledWith(false);
    expect(props.onLockChange).toHaveBeenCalledWith(false);
    expect(props.onRetentionEnabledChange).toHaveBeenCalledWith(false);
  });

  it('cascades lock off to retention', () => {
    const props = renderWithDefaults({ versioning: true, lock: true, retentionEnabled: true });
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

  it('renders lock period input and unit dropdown when retention is enabled', () => {
    renderWithDefaults({ versioning: true, lock: true, retentionEnabled: true });
    expect(screen.getByRole('spinbutton')).toHaveValue(15);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByText('Days')).toBeInTheDocument();
    expect(screen.getByText('Years')).toBeInTheDocument();
  });

  it('selects the correct retention mode radio', () => {
    renderWithDefaults({
      versioning: true,
      lock: true,
      retentionEnabled: true,
      retentionMode: 'governance',
    });
    const radios = screen.getAllByRole('radio');
    expect(radios[0]).toBeChecked();
    expect(radios[1]).not.toBeChecked();
  });

  it('calls onRetentionModeChange when switching mode', () => {
    const props = renderWithDefaults({
      versioning: true,
      lock: true,
      retentionEnabled: true,
      retentionMode: 'governance',
    });
    fireEvent.click(screen.getByLabelText(/Compliance/));
    expect(props.onRetentionModeChange).toHaveBeenCalledWith('compliance');
  });

  it('calls onRetentionDurationChange when editing the number input', () => {
    const props = renderWithDefaults({
      versioning: true,
      lock: true,
      retentionEnabled: true,
      retentionDuration: 15,
    });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '30' } });
    expect(props.onRetentionDurationChange).toHaveBeenCalledWith(30);
  });

  it('shows trial hint when trialDaysLeft is provided and retention is enabled', () => {
    renderWithDefaults({
      versioning: true,
      lock: true,
      retentionEnabled: true,
      trialDaysLeft: 14,
      retentionDuration: 7,
    });
    expect(screen.getByText(/trial ends in/i)).toBeInTheDocument();
    expect(screen.getByText('14 days')).toBeInTheDocument();
  });

  it('shows warning when retention period exceeds trial days', () => {
    renderWithDefaults({
      versioning: true,
      lock: true,
      retentionEnabled: true,
      trialDaysLeft: 14,
      retentionDuration: 30,
      retentionDurationType: 'd',
    });
    expect(screen.getByText(/Exceeds your 14-day trial period/i)).toBeInTheDocument();
  });

  it('does not show trial warning when period is within trial', () => {
    renderWithDefaults({
      versioning: true,
      lock: true,
      retentionEnabled: true,
      trialDaysLeft: 14,
      retentionDuration: 7,
      retentionDurationType: 'd',
    });
    expect(screen.queryByText(/Exceeds your/i)).not.toBeInTheDocument();
  });
});
