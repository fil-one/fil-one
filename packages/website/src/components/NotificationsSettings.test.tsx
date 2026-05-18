import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { PreferencesResponse } from '@filone/shared';

import { queryKeys } from '../lib/query-client.js';
import { ToastProvider } from './Toast/index.js';
import { NotificationSettings } from './NotificationsSettings.js';
import * as api from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}));

const getPreferencesMock = vi.mocked(api.getPreferences);
const updatePreferencesMock = vi.mocked(api.updatePreferences);

function renderSection(initial: PreferencesResponse) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData<PreferencesResponse>(queryKeys.preferences, initial);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <NotificationSettings />
        </ToastProvider>
      </QueryClientProvider>,
    ),
  };
}

function switchForRow(labelText: string): HTMLElement {
  const label = screen.getByText(labelText);
  const row = label.closest('div.flex.items-center.justify-between');
  if (!row) throw new Error(`Could not find row container for "${labelText}"`);
  return within(row as HTMLElement).getByRole('switch');
}

function getMarketingSwitch(): HTMLElement {
  return switchForRow('Marketing emails');
}

function getEmailNotificationsSwitch(): HTMLElement {
  return switchForRow('Email notifications');
}

describe('NotificationsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPreferencesMock.mockResolvedValue({ marketingEmailsOptedIn: false });
  });

  it('renders persisted opted-in state', () => {
    renderSection({ marketingEmailsOptedIn: true });
    expect(getMarketingSwitch()).toHaveAttribute('aria-checked', 'true');
  });

  it('toggles on by calling updatePreferences with true', async () => {
    updatePreferencesMock.mockResolvedValue({ marketingEmailsOptedIn: true });
    renderSection({ marketingEmailsOptedIn: false });

    fireEvent.click(getMarketingSwitch());

    await waitFor(() => {
      expect(updatePreferencesMock.mock.calls[0]?.[0]).toEqual({ marketingEmailsOptedIn: true });
    });
    await waitFor(() => {
      expect(getMarketingSwitch()).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('toggles off by calling updatePreferences with false', async () => {
    updatePreferencesMock.mockResolvedValue({ marketingEmailsOptedIn: false });
    renderSection({ marketingEmailsOptedIn: true });

    fireEvent.click(getMarketingSwitch());

    await waitFor(() => {
      expect(updatePreferencesMock.mock.calls[0]?.[0]).toEqual({ marketingEmailsOptedIn: false });
    });
    await waitFor(() => {
      expect(getMarketingSwitch()).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('disables the switch while the mutation is pending', async () => {
    let resolve: (value: PreferencesResponse) => void = () => {};
    updatePreferencesMock.mockReturnValue(
      new Promise<PreferencesResponse>((res) => {
        resolve = res;
      }),
    );
    renderSection({ marketingEmailsOptedIn: false });

    fireEvent.click(getMarketingSwitch());

    await waitFor(() => {
      expect(getMarketingSwitch()).toBeDisabled();
    });

    await act(async () => {
      resolve({ marketingEmailsOptedIn: true });
    });

    await waitFor(() => {
      expect(getMarketingSwitch()).not.toBeDisabled();
    });
  });

  it('shows a toast on error and keeps the previous state', async () => {
    updatePreferencesMock.mockRejectedValue(new Error('boom'));
    renderSection({ marketingEmailsOptedIn: false });

    fireEvent.click(getMarketingSwitch());

    expect(await screen.findByText(/boom/i)).toBeInTheDocument();
    expect(getMarketingSwitch()).toHaveAttribute('aria-checked', 'false');
  });

  it('keeps the email notifications row disabled with the Coming soon hint', () => {
    renderSection({ marketingEmailsOptedIn: false });
    expect(getEmailNotificationsSwitch()).toBeDisabled();
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });
});
