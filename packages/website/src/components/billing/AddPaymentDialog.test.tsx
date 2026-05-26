import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockConfirmCardSetup = vi.fn();
const mockGetElement = vi.fn();
const mockActivateSubscription = vi.fn();

vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CardNumberElement: () => <div data-testid="card-number" />,
  CardExpiryElement: () => <div data-testid="card-expiry" />,
  CardCvcElement: () => <div data-testid="card-cvc" />,
  useStripe: () => ({ confirmCardSetup: mockConfirmCardSetup }),
  useElements: () => ({ getElement: mockGetElement }),
}));

vi.mock('../../lib/stripe.js', () => ({
  getStripe: () => Promise.resolve({}),
}));

vi.mock('../../lib/api.js', () => ({
  activateSubscription: (...args: unknown[]) => mockActivateSubscription(...args),
}));

import { AddPaymentDialog } from './AddPaymentDialog';

async function renderDialog() {
  const onSuccess = vi.fn();
  const onClose = vi.fn();
  const onBack = vi.fn();
  render(
    <AddPaymentDialog
      open={true}
      clientSecret="seti_test_secret"
      stripePublishableKey="pk_test_123"
      onClose={onClose}
      onBack={onBack}
      onSuccess={onSuccess}
    />,
  );
  // getStripe resolves asynchronously, then the form renders.
  await screen.findByText('Add payment method');
  return { onSuccess, onClose, onBack };
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: /start subscription/i }));
}

function typePromo(value: string) {
  fireEvent.change(screen.getByLabelText(/Promo code/), { target: { value } });
}

describe('AddPaymentDialog — promotion code submission', () => {
  beforeEach(() => {
    mockConfirmCardSetup.mockReset();
    mockGetElement.mockReset();
    mockActivateSubscription.mockReset();
    mockGetElement.mockReturnValue({});
    mockConfirmCardSetup.mockResolvedValue({});
    mockActivateSubscription.mockResolvedValue(undefined);
  });

  it('omits promotionCode when the input is empty', async () => {
    const { onSuccess } = await renderDialog();
    submit();
    await waitFor(() => expect(mockActivateSubscription).toHaveBeenCalled());

    const arg = mockActivateSubscription.mock.calls[0][0];
    expect(arg).not.toHaveProperty('promotionCode');
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it('omits promotionCode when the input contains only whitespace', async () => {
    await renderDialog();
    typePromo('   ');
    submit();
    await waitFor(() => expect(mockActivateSubscription).toHaveBeenCalled());

    const arg = mockActivateSubscription.mock.calls[0][0];
    expect(arg).not.toHaveProperty('promotionCode');
  });

  it('sends a trimmed promotionCode when the input is a valid code', async () => {
    await renderDialog();
    typePromo('  PROMO-50  ');
    submit();
    await waitFor(() => expect(mockActivateSubscription).toHaveBeenCalled());

    expect(mockActivateSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ promotionCode: 'PROMO-50' }),
    );
  });

  it('shows a validation error and does not call activateSubscription for a malformed code', async () => {
    await renderDialog();
    typePromo('AB'); // too short — schema requires 3–40 chars
    submit();

    await screen.findByText(/Promo code must be/i);
    expect(mockActivateSubscription).not.toHaveBeenCalled();
    expect(mockConfirmCardSetup).not.toHaveBeenCalled();
  });
});
