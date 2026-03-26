import { CheckIcon, ArrowRightIcon, PhoneIcon } from '@phosphor-icons/react/dist/ssr';
import { Modal, ModalBody, ModalHeader } from '../Modal';

type ChoosePlanDialogProps = {
  open: boolean;
  onClose: () => void;
  onSelectPayAsYouGo: () => void;
  onContactSales: () => void;
};

const PAY_AS_YOU_GO_FEATURES = [
  'Pay monthly',
  'No egress fees',
  'No API request fees',
  'Data integrity guarantees',
];

const BUSINESS_FEATURES = [
  'Purchase in 1, 3, or 5-year increments',
  'No egress or API request fees',
  'Data integrity guarantees',
  'Capacity assurance and deployment SLAs',
];

export function ChoosePlanDialog({
  open,
  onClose,
  onSelectPayAsYouGo,
  onContactSales,
}: ChoosePlanDialogProps) {
  return (
    <Modal open={open} onClose={onClose} size="lg">
      <ModalHeader onClose={onClose}>Choose your plan</ModalHeader>
      <ModalBody>
        <p className="text-sm text-[#677183] mb-6">
          Simple, transparent pricing for teams of all sizes
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Pay as you go */}
          <div className="rounded-xl border border-[rgba(0, 128, 255, 0.2)] bg-[rgba(0, 128, 255, 0.03)] p-6 flex flex-col">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[#677183]">
              Pay-as-you-go
            </p>
            <div className="mt-3 flex items-baseline gap-1">
              <span className="text-3xl font-bold text-[#14181f]">$4.99</span>
              <span className="text-sm text-[#677183]">TB/month</span>
            </div>
            <p className="mt-3 text-sm text-[#677183]">
              Ideal for dynamic workloads or teams getting started with scalable, verifiable
              storage.
            </p>

            <ul className="mt-5 flex flex-col gap-2.5 flex-1">
              {PAY_AS_YOU_GO_FEATURES.map((f) => (
                <li key={f} className="flex items-center gap-2 text-sm text-[#3a4252]">
                  <CheckIcon size={16} className="text-[#10b77f] flex-shrink-0" weight="bold" />
                  {f}
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={onSelectPayAsYouGo}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[#0066ff] to-[#0052cc] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            >
              Upgrade now
              <ArrowRightIcon size={16} weight="bold" />
            </button>
          </div>

          {/* Business */}
          <div className="rounded-xl border border-[#e1e4ea] bg-white p-6 flex flex-col">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[#677183]">
              Business plan
            </p>
            <div className="mt-3">
              <span className="text-lg font-semibold text-[#14181f]">Custom pricing</span>
            </div>
            <p className="mt-3 text-sm text-[#677183]">
              Ideal for enterprises with predictable storage needs or compliance-driven
              requirements.
            </p>

            <ul className="mt-5 flex flex-col gap-2.5 flex-1">
              {BUSINESS_FEATURES.map((f) => (
                <li key={f} className="flex items-center gap-2 text-sm text-[#3a4252]">
                  <CheckIcon size={16} className="text-[#10b77f] flex-shrink-0" weight="bold" />
                  {f}
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={onContactSales}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg border border-[#0066ff] px-4 py-2.5 text-sm font-semibold text-[#0066ff] transition-colors hover:bg-[#f0f6ff]"
            >
              <PhoneIcon size={16} weight="bold" />
              Contact sales
            </button>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-[#99a0ae]">
          All plans include unlimited buckets, API keys, and 24/7 support
        </p>
      </ModalBody>
    </Modal>
  );
}
