import { CheckIcon, ArrowRightIcon } from '@phosphor-icons/react/dist/ssr';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../Modal';
import { Button } from '../Button';

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

function FeatureList({ features }: { features: string[] }) {
  return (
    <ul className="flex flex-col gap-2.5">
      {features.map((f) => (
        <li key={f} className="flex items-center gap-2 text-xs leading-[18px] text-zinc-600">
          <CheckIcon size={14} className="shrink-0 text-green-600" weight="bold" />
          {f}
        </li>
      ))}
    </ul>
  );
}

export function ChoosePlanDialog({
  open,
  onClose,
  onSelectPayAsYouGo,
  onContactSales,
}: ChoosePlanDialogProps) {
  return (
    <Modal open={open} onClose={onClose} size="lg">
      <ModalHeader
        onClose={onClose}
        description="Simple, transparent pricing for teams of all sizes"
      >
        Choose your plan
      </ModalHeader>
      <ModalBody>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Pay as you go */}
          <div className="flex flex-col rounded-xl border-2 border-brand-200 bg-brand-50 p-5">
            <p className="text-xs uppercase text-zinc-500">Pay-as-you-go</p>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="text-2xl font-bold text-zinc-950">$4.99</span>
              <span className="text-sm text-zinc-500">TB/month</span>
            </div>
            <p className="mt-2 text-xs leading-[18px] text-zinc-600">
              Ideal for dynamic workloads or teams getting started with scalable, verifiable
              storage.
            </p>

            <div className="mt-4 border-t border-brand-200 pt-5">
              <FeatureList features={PAY_AS_YOU_GO_FEATURES} />
            </div>

            <div className="flex-1" />

            <div className="mt-4">
              <Button
                variant="primary"
                icon={ArrowRightIcon}
                iconPosition="right"
                onClick={onSelectPayAsYouGo}
                className="w-full justify-center"
              >
                Upgrade now
              </Button>
            </div>
          </div>

          {/* Business */}
          <div className="flex flex-col rounded-xl border border-zinc-200 bg-white p-5">
            <p className="text-xs uppercase text-zinc-500">Business plan</p>
            <div className="mt-2">
              <span className="text-2xl font-bold text-zinc-950">Custom pricing</span>
            </div>
            <p className="mt-2 text-xs leading-[18px] text-zinc-600">
              Ideal for enterprises with predictable storage needs or compliance-driven
              requirements.
            </p>

            <div className="mt-4 border-t border-zinc-200 pt-5">
              <FeatureList features={BUSINESS_FEATURES} />
            </div>

            <div className="flex-1" />

            <div className="mt-4">
              <Button variant="ghost" onClick={onContactSales} className="w-full justify-center">
                Contact sales team
              </Button>
            </div>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <p className="w-full text-center text-xs text-zinc-500">
          All plans include unlimited buckets, API keys, and 24/7 support
        </p>
      </ModalFooter>
    </Modal>
  );
}
