import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ObjectSettingsFields } from './ObjectSettingsFields';

function renderWithDefaults(overrides: Partial<Parameters<typeof ObjectSettingsFields>[0]> = {}) {
  const props = {
    onRetentionModeChange: vi.fn(),
    retentionMode: 'governance' as const,
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
  it('renders retention policy options', () => {
    renderWithDefaults();
    expect(screen.getByText('Default Retention Policy')).toBeInTheDocument();
    expect(screen.getByText('Governance')).toBeInTheDocument();
    expect(screen.getByText('Compliance')).toBeInTheDocument();
  });

  it('renders lock period input and unit dropdown', () => {
    renderWithDefaults();
    expect(screen.getByText('Lock period')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton')).toHaveValue(15);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByText('Days')).toBeInTheDocument();
    expect(screen.getByText('Years')).toBeInTheDocument();
  });

  it('selects the correct retention mode radio', () => {
    renderWithDefaults({ retentionMode: 'governance' });
    const radios = screen.getAllByRole('radio');
    expect(radios[0]).toBeChecked();
    expect(radios[1]).not.toBeChecked();
  });

  it('calls onRetentionModeChange when switching mode', () => {
    const props = renderWithDefaults({ retentionMode: 'governance' });
    fireEvent.click(screen.getByLabelText(/Compliance/));
    expect(props.onRetentionModeChange).toHaveBeenCalledWith('compliance');
  });

  it('calls onRetentionDurationChange when editing the number input', () => {
    const props = renderWithDefaults({ retentionDuration: 15 });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '30' } });
    expect(props.onRetentionDurationChange).toHaveBeenCalledWith(30);
  });

  it('shows trial hint when trialDaysLeft is provided', () => {
    renderWithDefaults({ trialDaysLeft: 14 });
    expect(screen.getByText(/trial ends in/i)).toBeInTheDocument();
    expect(screen.getByText('14 days')).toBeInTheDocument();
  });

  it('shows warning when retention period exceeds trial days', () => {
    renderWithDefaults({ trialDaysLeft: 14, retentionDuration: 30, retentionDurationType: 'd' });
    expect(screen.getByText(/exceeds your remaining trial period/i)).toBeInTheDocument();
  });

  it('does not show trial warning when period is within trial', () => {
    renderWithDefaults({ trialDaysLeft: 14, retentionDuration: 7, retentionDurationType: 'd' });
    expect(screen.queryByText(/exceeds your remaining trial period/i)).not.toBeInTheDocument();
  });
});
