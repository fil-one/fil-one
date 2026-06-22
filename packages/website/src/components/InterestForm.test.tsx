import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { queryKeys } from '../lib/query-client.js';
import { InterestForm, type InterestFormConfig } from './InterestForm.js';

// Mock the HubSpot lib so the default submission path is observable without network.
const submitWaitlistForm = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/hubspot.js', () => ({
  submitWaitlistForm: (...args: unknown[]) => submitWaitlistForm(...args),
}));

const ragConfig: InterestFormConfig = {
  workloadLabel: 'Primary use case',
  workloadTypes: ['Document Q&A', 'Other'],
  providersLabel: 'How are you handling RAG today?',
  providers: ['LangChain', 'Other'],
  timelines: ['Just exploring'],
  notesPlaceholder: 'Notes',
};

const toolkitConfig: InterestFormConfig = {
  providersLabel: 'Which tools are you connecting?',
  providersMultiple: true,
  showStorageAmount: false,
  providers: ['Claude', 'Other'],
  timelines: ['Just exploring'],
  notesPlaceholder: 'Notes',
};

function renderForm(config: InterestFormConfig, onSubmit?: (v: unknown) => Promise<void>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.me, { name: 'Jane Doe', email: 'jane@acme.com' });
  return render(
    <QueryClientProvider client={client}>
      <InterestForm
        config={config}
        formGuid="form-123"
        onSubmit={onSubmit as never}
        onSubmitted={vi.fn()}
        onCancel={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  submitWaitlistForm.mockClear();
});

describe('InterestForm default (Bucket Intelligence) submission', () => {
  it('maps the single-select provider to ragProvider and name/email from the user', async () => {
    renderForm(ragConfig);

    fireEvent.change(screen.getByLabelText('How are you handling RAG today?'), {
      target: { value: 'LangChain' },
    });
    fireEvent.change(screen.getByLabelText('Primary use case'), {
      target: { value: 'Document Q&A' },
    });
    fireEvent.click(screen.getByRole('button', { name: /join waitlist/i }));

    await waitFor(() => expect(submitWaitlistForm).toHaveBeenCalledTimes(1));
    expect(submitWaitlistForm).toHaveBeenCalledWith(
      expect.objectContaining({
        formId: 'form-123',
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@acme.com',
        primaryUseCase: 'Document Q&A',
        ragProvider: 'LangChain',
      }),
    );
  });
});

describe('InterestForm multi-select (AI Agent Toolkit) submission', () => {
  it('passes selected tools plus the free-text Other value to the override handler', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(toolkitConfig, onSubmit);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Claude' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Other' }));
    fireEvent.change(screen.getByPlaceholderText('Which one?'), {
      target: { value: 'Windsurf' },
    });
    fireEvent.click(screen.getByRole('button', { name: /join waitlist/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: ['Claude', 'Other'],
        otherProvider: 'Windsurf',
      }),
    );
    // The default RAG submission must not fire when an override is provided.
    expect(submitWaitlistForm).not.toHaveBeenCalled();
  });
});
