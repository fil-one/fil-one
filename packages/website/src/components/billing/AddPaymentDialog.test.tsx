import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockStripe = {
  confirmCardSetup: vi.fn(),
};
const mockElements = {
  getElement: vi.fn(() => ({})),
};

vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CardNumberElement: ({
    onChange,
  }: {
    onChange?: (e: {
      brand: string;
      empty: boolean;
      complete: boolean;
      error?: { message: string };
    }) => void;
  }) => (
    <button
      type="button"
      data-testid="card-clear"
      onClick={() => onChange?.({ brand: 'unknown', empty: true, complete: false })}
    >
      card-clear
    </button>
  ),
  CardExpiryElement: () => <div data-testid="card-expiry" />,
  CardCvcElement: () => <div data-testid="card-cvc" />,
  useStripe: () => mockStripe,
  useElements: () => mockElements,
}));

vi.mock('../../lib/stripe.js', () => ({
  getStripe: vi.fn(() => Promise.resolve(mockStripe)),
}));

const activateSubscription = vi.fn();

vi.mock('../../lib/api.js', () => ({
  activateSubscription: (...args: unknown[]) => activateSubscription(...args),
}));

// Import after mocks are registered.
const { AddPaymentDialog } = await import('./AddPaymentDialog.js');

function renderDialog(
  overrides: Partial<Parameters<typeof AddPaymentDialog>[0]> = {},
  refreshImpl: () => Promise<string> = () => Promise.resolve('cs_refreshed'),
) {
  const refresh = vi.fn(refreshImpl);
  const props = {
    open: true,
    clientSecret: 'cs_A',
    stripePublishableKey: 'pk_test',
    onClose: vi.fn(),
    onBack: vi.fn(),
    onSuccess: vi.fn(),
    onRefreshSetupIntent: refresh,
    ...overrides,
  };
  return { ...render(<AddPaymentDialog {...props} />), props, refresh };
}

beforeEach(() => {
  activateSubscription.mockReset();
  mockStripe.confirmCardSetup.mockReset();
  mockElements.getElement.mockReset();
  mockElements.getElement.mockReturnValue({});
});

describe('AddPaymentDialog', () => {
  it('happy path: confirms card with the provided client secret and activates subscription', async () => {
    mockStripe.confirmCardSetup.mockResolvedValueOnce({ setupIntent: { status: 'succeeded' } });
    activateSubscription.mockResolvedValueOnce({});

    const { props, refresh } = renderDialog();

    const submitButton = await screen.findByRole('button', { name: /start subscription/i });
    fireEvent.click(submitButton);

    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledTimes(1));
    expect(refresh).not.toHaveBeenCalled();
    expect(mockStripe.confirmCardSetup).toHaveBeenCalledTimes(1);
    expect(mockStripe.confirmCardSetup).toHaveBeenCalledWith('cs_A', expect.any(Object));
    expect(activateSubscription).toHaveBeenCalledTimes(1);
    expect(activateSubscription).toHaveBeenCalledWith({ useSavedPaymentMethod: false });
  });

  it('same-card retry after bad promo: skips second confirm, retries activate', async () => {
    mockStripe.confirmCardSetup.mockResolvedValueOnce({ setupIntent: { status: 'succeeded' } });
    activateSubscription
      .mockRejectedValueOnce(new Error('Invalid or expired promo code.'))
      .mockResolvedValueOnce({});

    const { props, refresh } = renderDialog();

    const promoInput = await screen.findByPlaceholderText(/add promo code/i);
    fireEvent.change(promoInput, { target: { value: 'NOPENOPE' } });

    const submitButton = await screen.findByRole('button', { name: /start subscription/i });
    fireEvent.click(submitButton);

    await waitFor(() => expect(activateSubscription).toHaveBeenCalledTimes(1));
    await screen.findByText(/invalid or expired promo code/i);

    fireEvent.change(promoInput, { target: { value: '' } });
    fireEvent.click(submitButton);

    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledTimes(1));
    expect(refresh).not.toHaveBeenCalled();
    expect(mockStripe.confirmCardSetup).toHaveBeenCalledTimes(1);
    expect(activateSubscription).toHaveBeenCalledTimes(2);
  });

  it('different-card retry: clearing the card field refreshes the SetupIntent', async () => {
    mockStripe.confirmCardSetup
      .mockResolvedValueOnce({ setupIntent: { status: 'succeeded' } })
      .mockResolvedValueOnce({ setupIntent: { status: 'succeeded' } });
    activateSubscription
      .mockRejectedValueOnce(new Error('Invalid or expired promo code.'))
      .mockResolvedValueOnce({});

    const { props, refresh } = renderDialog({}, () => Promise.resolve('cs_B'));

    const promoInput = await screen.findByPlaceholderText(/add promo code/i);
    fireEvent.change(promoInput, { target: { value: 'NOPENOPE' } });

    const submitButton = await screen.findByRole('button', { name: /start subscription/i });
    fireEvent.click(submitButton);

    await waitFor(() => expect(activateSubscription).toHaveBeenCalledTimes(1));

    // User clears the card field to enter a different card. Stripe fires
    // onChange with empty: true.
    fireEvent.click(screen.getByTestId('card-clear'));

    fireEvent.change(promoInput, { target: { value: '' } });
    fireEvent.click(submitButton);

    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledTimes(1));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mockStripe.confirmCardSetup).toHaveBeenCalledTimes(2);
    expect(mockStripe.confirmCardSetup.mock.calls[0][0]).toBe('cs_A');
    expect(mockStripe.confirmCardSetup.mock.calls[1][0]).toBe('cs_B');
    expect(activateSubscription).toHaveBeenCalledTimes(2);
  });

  it('card confirm error on first try: no refresh, error shown, retry uses same secret', async () => {
    mockStripe.confirmCardSetup
      .mockResolvedValueOnce({ error: { message: 'Your card was declined.' } })
      .mockResolvedValueOnce({ setupIntent: { status: 'succeeded' } });
    activateSubscription.mockResolvedValueOnce({});

    const { props, refresh } = renderDialog();

    const submitButton = await screen.findByRole('button', { name: /start subscription/i });
    fireEvent.click(submitButton);

    await screen.findByText(/your card was declined/i);
    expect(refresh).not.toHaveBeenCalled();
    expect(activateSubscription).not.toHaveBeenCalled();

    fireEvent.click(submitButton);

    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledTimes(1));
    expect(refresh).not.toHaveBeenCalled();
    expect(mockStripe.confirmCardSetup).toHaveBeenCalledTimes(2);
    expect(mockStripe.confirmCardSetup.mock.calls[0][0]).toBe('cs_A');
    expect(mockStripe.confirmCardSetup.mock.calls[1][0]).toBe('cs_A');
  });
});
