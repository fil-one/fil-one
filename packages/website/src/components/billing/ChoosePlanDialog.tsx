import { CheckIcon, ArrowRightIcon } from '@phosphor-icons/react/dist/ssr';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../Modal';

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
        <p className="text-[13px] text-[#677183] mb-4">
          Simple, transparent pricing for teams of all sizes
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Pay as you go */}
          <div className="rounded-xl border-2 border-[rgba(0,128,255,0.2)] bg-gradient-to-b from-[rgba(0,128,255,0.03)] to-[rgba(0,128,255,0.06)] p-[22px] flex flex-col">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[#677183]">
              Pay-as-you-go
            </p>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="text-2xl font-bold text-[#14181f]">$4.99</span>
              <span className="text-[13px] text-[#677183]">TB/month</span>
            </div>
            <p className="mt-2 text-[12px] leading-[18px] text-[#677183]">
              Ideal for dynamic workloads or teams getting started with scalable, verifiable
              storage.
            </p>

            <div className="mt-4 border-t border-[rgba(225,228,234,0.5)] pt-[19px]">
              <ul className="flex flex-col gap-2.5">
                {PAY_AS_YOU_GO_FEATURES.map((f) => (
                  <li
                    key={f}
                    className="flex items-center gap-2 text-[12px] leading-[18px] text-[#677183]"
                  >
                    <CheckIcon size={14} className="text-[#677183] flex-shrink-0" weight="bold" />
                    {f}
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex-1" />

            <button
              type="button"
              onClick={onSelectPayAsYouGo}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-gradient-to-br from-[#0080ff] to-[#256af4] px-4 py-2 text-[13px] font-medium text-white shadow-[0px_1px_2px_0px_rgba(0,0,0,0.05)] transition-opacity hover:opacity-90"
            >
              Upgrade now
              <ArrowRightIcon size={16} weight="bold" />
            </button>
          </div>

          {/* Business */}
          <div className="rounded-xl border border-[rgba(225,228,234,0.5)] bg-gradient-to-b from-[rgba(243,244,246,0.2)] to-[rgba(243,244,246,0.4)] p-[21px] flex flex-col">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[#677183]">
              Business plan
            </p>
            <div className="mt-2">
              <span className="text-2xl font-bold text-[#14181f]">Custom pricing</span>
            </div>
            <p className="mt-2 text-[12px] leading-[18px] text-[#677183]">
              Ideal for enterprises with predictable storage needs or compliance-driven
              requirements.
            </p>

            <div className="mt-4 border-t border-[rgba(225,228,234,0.5)] pt-[19px]">
              <ul className="flex flex-col gap-2.5">
                {BUSINESS_FEATURES.map((f) => (
                  <li
                    key={f}
                    className="flex items-center gap-2 text-[12px] leading-[18px] text-[#677183]"
                  >
                    <CheckIcon size={14} className="text-[#677183] flex-shrink-0" weight="bold" />
                    {f}
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex-1" />

            <button
              type="button"
              onClick={onContactSales}
              className="mt-4 flex w-full items-center justify-center rounded-md border border-[#e1e4ea] bg-[#f9fafb] px-4 py-2 text-[13px] font-medium text-[#14181f] shadow-[0px_1px_2px_0px_rgba(20,24,31,0.03)] transition-colors hover:bg-[#f0f2f5]"
            >
              Contact sales team
            </button>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <p className="text-center text-[11px] text-[#677183]">
          All plans include unlimited buckets, API keys, and 24/7 support
        </p>
      </ModalFooter>
    </Modal>
  );
}
