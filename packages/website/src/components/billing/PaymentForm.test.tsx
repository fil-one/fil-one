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

vi.mock('../../lib/api.js', () => ({
  activateSubscription: (...args: unknown[]) => mockActivateSubscription(...args),
}));

import { Modal } from '../Modal/index.js';
import { PaymentForm } from './PaymentForm';

function renderForm() {
  const onSuccess = vi.fn();
  const onClose = vi.fn();
  const onBack = vi.fn();
  const onRefreshSetupIntent = vi.fn(() => Promise.resolve('seti_refreshed_secret'));
  render(
    <Modal open={true} onClose={onClose} size="sm">
      <PaymentForm
        initialClientSecret="seti_test_secret"
        onClose={onClose}
        onBack={onBack}
        onSuccess={onSuccess}
        onRefreshSetupIntent={onRefreshSetupIntent}
      />
    </Modal>,
  );
  return { onSuccess, onClose, onBack, onRefreshSetupIntent };
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: /start subscription/i }));
}

function typePromo(value: string) {
  fireEvent.change(screen.getByLabelText(/Promo code/), { target: { value } });
}

describe('PaymentForm — promotion code submission', () => {
  beforeEach(() => {
    mockConfirmCardSetup.mockReset();
    mockGetElement.mockReset();
    mockActivateSubscription.mockReset();
    mockGetElement.mockReturnValue({});
    mockConfirmCardSetup.mockResolvedValue({});
    mockActivateSubscription.mockResolvedValue(undefined);
  });

  it('omits promotionCode when the input is empty', async () => {
    const { onSuccess } = renderForm();
    submit();
    await waitFor(() => expect(mockActivateSubscription).toHaveBeenCalled());

    const arg = mockActivateSubscription.mock.calls[0][0];
    expect(arg).not.toHaveProperty('promotionCode');
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it('omits promotionCode when the input contains only whitespace', async () => {
    renderForm();
    typePromo('   ');
    submit();
    await waitFor(() => expect(mockActivateSubscription).toHaveBeenCalled());

    const arg = mockActivateSubscription.mock.calls[0][0];
    expect(arg).not.toHaveProperty('promotionCode');
  });

  it('sends a trimmed promotionCode when the input is a valid code', async () => {
    renderForm();
    typePromo('  PROMO-50  ');
    submit();
    await waitFor(() => expect(mockActivateSubscription).toHaveBeenCalled());

    expect(mockActivateSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ promotionCode: 'PROMO-50' }),
    );
  });

  it('shows a validation error and does not call activateSubscription for a malformed code', async () => {
    renderForm();
    typePromo('AB'); // too short — schema requires 3–40 chars
    submit();

    await screen.findByText(/Promo code must be/i);
    expect(mockActivateSubscription).not.toHaveBeenCalled();
    expect(mockConfirmCardSetup).not.toHaveBeenCalled();
  });
});
