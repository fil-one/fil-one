import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockConfirmCardSetup = vi.fn();
const mockGetElement = vi.fn();
const mockActivateSubscription = vi.fn();
const mockCheckPromotionCode = vi.fn();

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
  checkPromotionCode: (...args: unknown[]) => mockCheckPromotionCode(...args),
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

describe('PaymentForm: checking a promo code before submitting', () => {
  beforeEach(() => {
    mockConfirmCardSetup.mockReset();
    mockGetElement.mockReset();
    mockActivateSubscription.mockReset();
    mockCheckPromotionCode.mockReset();
    mockGetElement.mockReturnValue({});
    mockConfirmCardSetup.mockResolvedValue({});
    mockActivateSubscription.mockResolvedValue(undefined);
    mockCheckPromotionCode.mockResolvedValue({
      discount: {
        promotionCode: 'ANY-CODE',
        duration: 'repeating',
        durationInMonths: 3,
        percentOff: 20,
      },
    });
  });

  function apply() {
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  }

  it('shows what a valid code takes off once applied', async () => {
    renderForm();
    typePromo(' any-code ');
    apply();

    expect(await screen.findByTestId('applied-discount')).toHaveTextContent(
      'ANY-CODE applied: 20% off for 3 months',
    );
    expect(mockCheckPromotionCode).toHaveBeenCalledWith({ promotionCode: 'any-code' });
  });

  it('shows the refusal under the field when the code is not valid', async () => {
    mockCheckPromotionCode.mockRejectedValue(new Error('Invalid or expired promo code.'));
    renderForm();
    typePromo('ANY-CODE');
    apply();

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid or expired promo code.');
    expect(screen.queryByTestId('applied-discount')).toBeNull();
  });

  it('checks a malformed code locally without asking the server', async () => {
    renderForm();
    typePromo('AB'); // too short: the schema requires 3 to 40 characters
    apply();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Promo code must be/);
    expect(mockCheckPromotionCode).not.toHaveBeenCalled();
  });

  it('applies the code on Enter instead of starting the subscription', async () => {
    renderForm();
    typePromo('ANY-CODE');
    fireEvent.keyDown(screen.getByLabelText(/Promo code/), { key: 'Enter' });

    await screen.findByTestId('applied-discount');
    expect(mockConfirmCardSetup).not.toHaveBeenCalled();
    expect(mockActivateSubscription).not.toHaveBeenCalled();
  });

  it('drops the applied discount when the code is edited', async () => {
    renderForm();
    typePromo('ANY-CODE');
    apply();
    await screen.findByTestId('applied-discount');

    typePromo('OTHER-CODE');

    expect(screen.queryByTestId('applied-discount')).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it('clears the code and its discount on Remove', async () => {
    renderForm();
    typePromo('ANY-CODE');
    apply();
    await screen.findByTestId('applied-discount');

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.getByLabelText(/Promo code/)).toHaveValue('');
    expect(screen.queryByTestId('applied-discount')).toBeNull();
  });

  it('reports the promo code the subscription started with', async () => {
    const { onSuccess } = renderForm();
    typePromo('ANY-CODE');
    submit();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('ANY-CODE'));
  });
});
