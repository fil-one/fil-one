import { useState } from 'react'

import { CheckIcon, CreditCardIcon } from '@phosphor-icons/react/dist/ssr'

import { Button } from '@hyperspace/ui/Button'
import { Input } from '@hyperspace/ui/Input'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@hyperspace/ui/Modal'
import { ProgressBar } from '@hyperspace/ui/ProgressBar'
import { useToast } from '@hyperspace/ui/Toast'

import type { BillingInfo, PaymentMethod, Plan, PlanId } from '@hyperspace/shared'

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_PLANS: Plan[] = [
  {
    id: 'free_trial',
    name: 'Free Trial',
    description: '14-day trial with 1 TiB storage and 10 TiB downloads',
    storageLimitBytes: 1099511627776,
    downloadLimitBytes: 10995116277760,
    pricePerTibCents: 0,
    features: ['1 TiB storage', '10 TiB downloads', 'Up to 100 buckets', 'S3-compatible API'],
  },
  {
    id: 'pay_as_you_go',
    name: 'Pay As You Go',
    description: 'Pay only for what you use, no monthly commitment',
    storageLimitBytes: -1,
    downloadLimitBytes: -1,
    pricePerTibCents: 499,
    features: ['Unlimited storage', 'Unlimited downloads', '$4.99/TiB stored', 'No monthly fee'],
  },
  {
    id: 'starter',
    name: 'Starter',
    description: 'For small teams with predictable usage',
    storageLimitBytes: 10995116277760,
    downloadLimitBytes: 109951162777600,
    flatPriceCents: 4900,
    pricePerTibCents: 0,
    features: ['10 TiB storage', '100 TiB downloads', '$49/month flat rate', 'Priority support'],
  },
]

const MOCK_BILLING: BillingInfo = {
  subscription: {
    planId: 'free_trial',
    status: 'trialing',
    trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  },
  paymentMethod: undefined,
  plans: MOCK_PLANS,
}

// Mocked usage stats — these would normally come from the API
const MOCK_USAGE = {
  storageUsedBytes: 6979321856, // ~6.5 GB
  storageLimitBytes: 1099511627776, // 1 TiB
  downloadsUsedBytes: 0,
  downloadsLimitBytes: 10995116277760, // 10 TiB
  bucketsCount: 3,
  bucketsLimit: 100,
  objectsCount: 342,
  accessKeysCount: 2,
  accessKeysLimit: 300,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

function daysRemaining(isoString: string): number {
  const ms = new Date(isoString).getTime() - Date.now()
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)))
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type UsageRowProps = {
  label: string
  value: string
  percent?: number
}

function UsageRow({ label, value, percent }: UsageRowProps) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-zinc-100 last:border-0">
      <span className="text-sm font-medium text-zinc-700 w-32 shrink-0">{label}</span>
      <span className="text-sm text-zinc-600 flex-1">{value}</span>
      {percent !== undefined ? (
        <div className="flex items-center gap-2 w-32 justify-end">
          <ProgressBar value={percent} size="sm" className="w-24" label={label} />
          <span className="text-xs text-zinc-400 w-8 text-right">{percent.toFixed(1)}%</span>
        </div>
      ) : (
        <div className="w-32" />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function BillingPage() {
  const { toast } = useToast()

  const [billing, setBilling] = useState<BillingInfo>(MOCK_BILLING)
  const [planOpen, setPlanOpen] = useState(false)
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [selectedPlan, setSelectedPlan] = useState<PlanId>('pay_as_you_go')

  // Payment form state
  const [cardNumber, setCardNumber] = useState('')
  const [expiry, setExpiry] = useState('')
  const [cvc, setCvc] = useState('')

  const currentPlan = billing.plans.find((p) => p.id === billing.subscription.planId)
  const isTrialing = billing.subscription.status === 'trialing'
  const trialDays =
    isTrialing && billing.subscription.trialEndsAt
      ? daysRemaining(billing.subscription.trialEndsAt)
      : null

  const storagePct =
    MOCK_USAGE.storageLimitBytes > 0
      ? (MOCK_USAGE.storageUsedBytes / MOCK_USAGE.storageLimitBytes) * 100
      : 0
  const downloadsPct =
    MOCK_USAGE.downloadsLimitBytes > 0
      ? (MOCK_USAGE.downloadsUsedBytes / MOCK_USAGE.downloadsLimitBytes) * 100
      : 0

  // Determine the CTA label for the Current Plan card
  function getPlanCta(): string {
    if (!billing.paymentMethod) return 'Add payment method'
    if (isTrialing) return 'Upgrade now'
    return 'Choose a plan'
  }

  function handlePlanCtaClick() {
    if (!billing.paymentMethod) {
      setPaymentOpen(true)
    } else {
      setPlanOpen(true)
    }
  }

  function handleAddPayment() {
    // UNKNOWN: Real Stripe integration needed. This mocks a successful card save.
    const mockMethod: PaymentMethod = {
      id: 'pm_mock_1',
      last4: '4242',
      brand: 'Visa',
      expMonth: 12,
      expYear: 26,
    }
    setBilling((prev) => ({ ...prev, paymentMethod: mockMethod }))
    setCardNumber('')
    setExpiry('')
    setCvc('')
    setPaymentOpen(false)
    toast.success('Payment method added')
  }

  function handleRemovePayment() {
    setBilling((prev) => ({ ...prev, paymentMethod: undefined }))
    toast.success('Payment method removed')
  }

  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold text-zinc-900 mb-6">Billing</h1>

      {/* ------------------------------------------------------------------ */}
      {/* Current Plan */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg border border-zinc-200 bg-white p-6 mb-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-4">
          Current Plan
        </h2>
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold text-zinc-900">
                {currentPlan?.name ?? billing.subscription.planId}
              </span>
              {isTrialing && (
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">
                  Trial
                </span>
              )}
            </div>
            {trialDays !== null && (
              <span className="text-sm text-zinc-500">{trialDays} days remaining</span>
            )}
            {currentPlan && (
              <p className="text-sm text-zinc-600 mt-1">
                {currentPlan.features.join(' · ')}
              </p>
            )}
          </div>
          <div className="shrink-0">
            <Button variant="filled" onClick={handlePlanCtaClick}>
              {getPlanCta()}
            </Button>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Payment Method */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg border border-zinc-200 bg-white p-6 mb-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-4">
          Payment Method
        </h2>
        {billing.paymentMethod ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CreditCardIcon size={20} className="text-zinc-500" />
              <span className="text-sm text-zinc-700">
                {billing.paymentMethod.brand} ending in {billing.paymentMethod.last4}
              </span>
              <span className="text-sm text-zinc-500">
                Exp {String(billing.paymentMethod.expMonth).padStart(2, '0')}/
                {String(billing.paymentMethod.expYear).slice(-2)}
              </span>
            </div>
            <Button variant="ghost" onClick={handleRemovePayment}>
              Remove
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-zinc-500">No payment method on file.</p>
            <div>
              <Button variant="ghost" onClick={() => setPaymentOpen(true)}>
                Add payment method
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Usage This Period */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg border border-zinc-200 bg-white p-6">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-4">
          Usage This Period
        </h2>
        <UsageRow
          label="Storage used"
          value={`${formatBytes(MOCK_USAGE.storageUsedBytes)} / ${formatBytes(MOCK_USAGE.storageLimitBytes)}`}
          percent={storagePct}
        />
        <UsageRow
          label="Downloads"
          value={`${formatBytes(MOCK_USAGE.downloadsUsedBytes)} / ${formatBytes(MOCK_USAGE.downloadsLimitBytes)}`}
          percent={downloadsPct}
        />
        <UsageRow
          label="Buckets"
          value={`${MOCK_USAGE.bucketsCount} / ${MOCK_USAGE.bucketsLimit}`}
        />
        <UsageRow
          label="Objects"
          value={String(MOCK_USAGE.objectsCount)}
        />
        <UsageRow
          label="Access Keys"
          value={`${MOCK_USAGE.accessKeysCount} / ${MOCK_USAGE.accessKeysLimit}`}
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Choose Plan Modal */}
      {/* ------------------------------------------------------------------ */}
      <Modal open={planOpen} onClose={() => setPlanOpen(false)} size="lg">
        <ModalHeader onClose={() => setPlanOpen(false)}>Choose your plan</ModalHeader>
        <ModalBody>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {MOCK_PLANS.filter((p) => p.id !== 'free_trial').map((plan) => (
              <div
                key={plan.id}
                onClick={() => setSelectedPlan(plan.id)}
                className={[
                  'cursor-pointer rounded-lg border-2 p-4 transition-colors',
                  selectedPlan === plan.id
                    ? 'border-brand-600 bg-brand-50'
                    : 'border-zinc-200 hover:border-zinc-300',
                ].join(' ')}
              >
                <h3 className="font-semibold text-zinc-900">{plan.name}</h3>
                <p className="mt-1 text-sm text-zinc-500">{plan.description}</p>
                <p className="mt-3 text-2xl font-bold text-zinc-900">
                  {plan.flatPriceCents
                    ? `$${(plan.flatPriceCents / 100).toFixed(0)}/mo`
                    : `$${(plan.pricePerTibCents / 100).toFixed(2)}/TiB`}
                </p>
                <ul className="mt-3 flex flex-col gap-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-1.5 text-xs text-zinc-600">
                      <CheckIcon size={12} className="text-green-500 flex-shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </ModalBody>
        <ModalFooter>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPlanOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="filled"
              onClick={() => {
                setPlanOpen(false)
                setPaymentOpen(true)
              }}
            >
              Continue to payment
            </Button>
          </div>
        </ModalFooter>
      </Modal>

      {/* ------------------------------------------------------------------ */}
      {/* Add Payment Method Modal */}
      {/* ------------------------------------------------------------------ */}
      <Modal open={paymentOpen} onClose={() => setPaymentOpen(false)} size="sm">
        <ModalHeader onClose={() => setPaymentOpen(false)}>Add payment method</ModalHeader>
        <ModalBody>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-zinc-700">Card number</label>
              <Input
                value={cardNumber}
                onChange={setCardNumber}
                placeholder="4242 4242 4242 4242"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-zinc-700">Expiry</label>
                <Input value={expiry} onChange={setExpiry} placeholder="MM/YY" />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-zinc-700">CVC</label>
                <Input value={cvc} onChange={setCvc} placeholder="123" />
              </div>
            </div>
            <p className="text-xs text-zinc-400">
              {/* UNKNOWN: Real Stripe integration needed. This is a UI-only placeholder. */}
              Your payment information is encrypted and secure.
            </p>
          </div>
        </ModalBody>
        <ModalFooter>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPaymentOpen(false)}>
              Cancel
            </Button>
            <Button variant="filled" onClick={handleAddPayment}>
              Add payment method
            </Button>
          </div>
        </ModalFooter>
      </Modal>
    </div>
  )
}
