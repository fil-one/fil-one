import { useState } from 'react';
import {
  CaretDownIcon,
  CheckIcon,
} from '@phosphor-icons/react/dist/ssr';

import { Alert } from './Alert.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { Heading } from './Heading/Heading.js';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './Modal/index.js';
import { Select } from './Select.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComingSoonFeature = {
  category: string;
  title: string;
  description: string;
};

export type ComingSoonUseCase = {
  category: string;
  title: string;
  description: string;
};

export type ComingSoonFaq = {
  question: string;
  answer: string;
};

export type ComingSoonPageProps = {
  title: string;
  description: string;
  what: string;
  features: ComingSoonFeature[];
  useCases: ComingSoonUseCase[];
  whyFilOne: { title: string; description: string }[];
  pricing: {
    headline: string;
    subline: string;
    inclusions: string[];
  };
  interestForm: {
    workloadLabel: string;
    workloadTypes: string[];
    timelines: string[];
    providers: string[];
    notesPlaceholder: string;
  };
  faqs: ComingSoonFaq[];
  onEnable?: () => void;
};

export type AddOnDisabledPageProps = {
  title: string;
  description: string;
  what: string;
  features: ComingSoonFeature[];
  useCases: ComingSoonUseCase[];
  whyFilOne: { title: string; description: string }[];
  enableCard: {
    headline: string;
    subline: string;
    inclusions: string[];
    notIncludedNote?: string;
  };
  onEnable: () => void;
};

// ---------------------------------------------------------------------------
// Shared content blocks
// ---------------------------------------------------------------------------

function FeaturePills({ features }: { features: ComingSoonFeature[] }) {
  return (
    <div className="mb-10 inline-flex items-stretch divide-x divide-zinc-200 rounded-xl border border-zinc-200 bg-zinc-50 overflow-hidden">
      {features.map((f) => (
        <div key={f.title} className="flex items-center gap-2 px-4 py-2.5">
          <CheckIcon size={10} weight="bold" className="text-zinc-400 flex-shrink-0" />
          <span className="text-sm font-medium text-zinc-600">{f.title}</span>
        </div>
      ))}
    </div>
  );
}

function UseCasesSection({ useCases }: { useCases: ComingSoonUseCase[] }) {
  return (
    <section>
      <Heading tag="h2" size="xl" className="mb-6">
        Common use cases
      </Heading>
      <div className="grid grid-cols-3 gap-4">
        {useCases.map((uc) => (
          <div key={uc.title} className="rounded-xl border border-zinc-200 bg-zinc-50 p-5">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">{uc.category}</p>
            <p className="mb-1.5 text-sm font-semibold text-zinc-900">{uc.title}</p>
            <p className="text-sm leading-relaxed text-zinc-500">{uc.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function WhyFilOneSection({ items }: { items: { title: string; description: string }[] }) {
  return (
    <section>
      <Heading tag="h2" size="xl" className="mb-6">
        Why Fil One?
      </Heading>
      <div className="grid grid-cols-2 gap-x-12 gap-y-8">
        {items.map((item) => (
          <div key={item.title} className="flex items-start gap-3">
            <div className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-brand-100">
              <CheckIcon size={11} weight="bold" className="text-brand-700" />
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold text-zinc-900">{item.title}</p>
              <p className="text-sm leading-relaxed text-zinc-500">{item.description}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PricingCard({
  headline,
  subline,
  features,
  inclusions,
  onJoinClick,
}: {
  headline: string;
  subline: string;
  features: ComingSoonFeature[];
  inclusions: string[];
  onJoinClick: () => void;
}) {
  return (
    <div className="w-80 flex-shrink-0 rounded-lg border border-zinc-200 bg-white shadow-sm overflow-hidden p-px">
      {/* Header */}
      <div className="flex flex-col gap-[6px] px-6 pt-6 pb-5 border-b border-zinc-200/50 bg-zinc-50">
        <p className="text-[11px] font-medium uppercase tracking-[0.55px] leading-[16.5px] text-zinc-500">
          Early access
        </p>
        <span className="text-xl font-medium text-zinc-900">{headline}</span>
        <p className="text-[12px] leading-[18px] text-zinc-500">{subline}</p>
      </div>

      {/* Inclusions + CTA */}
      <div className="flex flex-col gap-4 p-6">
        <ul className="flex flex-col gap-[10px]">
          {inclusions.map((item) => (
            <li key={item} className="flex items-center gap-[10px] text-[13px] text-zinc-500">
              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-zinc-100">
                <CheckIcon size={12} weight="bold" className="text-zinc-700" />
              </span>
              {item}
            </li>
          ))}
        </ul>

        <div className="space-y-2">
          <Button
            type="button"
            variant="primary"
            size="lg"
            className="w-full justify-center"
            onClick={onJoinClick}
          >
            Join the waitlist
          </Button>
          <p className="text-center text-xs text-zinc-400">
            We'll reach out when alpha invites open.
          </p>
        </div>
      </div>
    </div>
  );
}

function AccordionItem({ question, answer }: ComingSoonFaq) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-zinc-100 last:border-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-4 py-4 text-left"
      >
        <span className="text-sm font-medium text-zinc-900">{question}</span>
        <CaretDownIcon
          size={14}
          className={`flex-shrink-0 text-zinc-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <p className="pb-4 text-sm leading-relaxed text-zinc-500">{answer}</p>
      )}
    </div>
  );
}

function InterestForm({
  title,
  config,
  onSuccess,
  onCancel,
}: {
  title: string;
  config: ComingSoonPageProps['interestForm'];
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [workload, setWorkload] = useState('');
  const [timeline, setTimeline] = useState('');
  const [provider, setProvider] = useState('');
  const [teamSize, setTeamSize] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    await new Promise((r) => setTimeout(r, 700));
    setSubmitting(false);
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="px-6 py-6">
        <Alert
          variant="green"
          title="You're on the list"
          description={`Thanks for sharing your use case. We'll reach out when ${title} is ready for alpha access.`}
        />
        <div className="mt-4 flex justify-end">
          <Button type="button" variant="secondary" size="md" onClick={onSuccess}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="px-6 py-6">
      <div className="grid grid-cols-2 gap-x-6 gap-y-5">
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
            {config.workloadLabel}
          </label>
          <Select value={workload} onChange={setWorkload}>
            <option value="">Select…</option>
            {config.workloadTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
        </div>

        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
            Where do you run today?
          </label>
          <Select value={provider} onChange={setProvider}>
            <option value="">Select…</option>
            {config.providers.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </Select>
        </div>

        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
            Timeline
          </label>
          <Select value={timeline} onChange={setTimeline}>
            <option value="">Select…</option>
            {config.timelines.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
        </div>

        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
            Team size
          </label>
          <Select value={teamSize} onChange={setTeamSize}>
            <option value="">Select…</option>
            <option value="just-me">Just me</option>
            <option value="2-10">2–10 people</option>
            <option value="11-50">11–50 people</option>
            <option value="51+">51+ people</option>
          </Select>
        </div>
      </div>

      <div className="mt-5">
        <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
          Notes{' '}
          <span className="normal-case tracking-normal text-zinc-400">(optional)</span>
        </label>
        <textarea
          rows={3}
          placeholder={config.notesPlaceholder}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full rounded-md border border-(--input-border-color) bg-white px-3 py-2.5 text-sm text-(--color-text-base) placeholder:text-(--input-placeholder-color) focus-visible:brand-outline"
        />
      </div>

      <div className="mt-5 flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="md" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="md" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Join waitlist'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ComingSoonPage({
  title,
  description,
  what,
  features,
  useCases,
  whyFilOne,
  pricing,
  interestForm,
  faqs,
  onEnable,
}: ComingSoonPageProps) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <div className="px-10 py-12 pb-20">
        <div className="flex items-start gap-12">

          {/* ── Left: scrollable content ── */}
          <div className="flex-1 min-w-0 space-y-20">

            {/* Hero */}
            <div>
              <Heading tag="h1" size="2xl" description={description} className="mb-10">
                <span className="inline-flex items-center gap-2.5">
                  {title}
                  <Badge color="grey" size="sm" strength="strong">
                    Coming Soon
                  </Badge>
                </span>
              </Heading>

              <FeaturePills features={features} />

              <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                Overview
              </p>
              <p className="text-base leading-relaxed text-zinc-600">{what}</p>
            </div>

            {/* Common use cases */}
            <UseCasesSection useCases={useCases} />

            {/* Why Fil One */}
            <WhyFilOneSection items={whyFilOne} />

            {/* FAQ */}
            <section>
              <Heading tag="h2" size="xl" className="mb-2">
                Common questions
              </Heading>
              <div className="mt-6">
                {faqs.map((faq) => (
                  <AccordionItem key={faq.question} {...faq} />
                ))}
              </div>
            </section>

          </div>

          {/* ── Right: sticky card ── */}
          <div className="w-80 flex-shrink-0 sticky top-8 flex flex-col gap-3">
            <PricingCard
              headline={pricing.headline}
              subline={pricing.subline}
              features={features}
              inclusions={pricing.inclusions}
              onJoinClick={() => setModalOpen(true)}
            />
            {onEnable && (
              <div className="text-center">
                <button
                  type="button"
                  onClick={onEnable}
                  className="text-xs text-zinc-400 underline underline-offset-2 transition-colors hover:text-zinc-600"
                >
                  See feature mockup
                </button>
              </div>
            )}
          </div>

        </div>
      </div>

      {/* ── Waitlist modal ── */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} size="md">
        <ModalHeader
          onClose={() => setModalOpen(false)}
          description="Helps us prioritise the first wave of alpha invitations."
        >
          Tell us about your use case
        </ModalHeader>
        <InterestForm
          title={title}
          config={interestForm}
          onSuccess={() => setModalOpen(false)}
          onCancel={() => setModalOpen(false)}
        />
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Disabled page (full motivating layout + enable CTA)
// ---------------------------------------------------------------------------

function EnableCard({
  title,
  headline,
  subline,
  inclusions,
  notIncludedNote,
  onEnableClick,
}: {
  title: string;
  headline: string;
  subline: string;
  inclusions: string[];
  notIncludedNote?: string;
  onEnableClick: () => void;
}) {
  return (
    <div className="w-80 flex-shrink-0 rounded-lg border border-zinc-200 bg-white shadow-sm overflow-hidden p-px">
      <div className="flex flex-col gap-[6px] px-6 pt-6 pb-5 border-b border-zinc-200/50 bg-zinc-50">
        <p className="text-[11px] font-medium uppercase tracking-[0.55px] leading-[16.5px] text-zinc-500">
          Pricing
        </p>
        <span className="text-xl font-medium text-zinc-900">{headline}</span>
        <p className="text-[12px] leading-[18px] text-zinc-500">{subline}</p>
      </div>

      <div className="flex flex-col gap-4 p-6">
        <ul className="flex flex-col gap-[10px]">
          {inclusions.map((item) => (
            <li key={item} className="flex items-center gap-[10px] text-[13px] text-zinc-500">
              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-zinc-100">
                <CheckIcon size={12} weight="bold" className="text-zinc-700" />
              </span>
              {item}
            </li>
          ))}
        </ul>

        {notIncludedNote && (
          <div className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3">
            <p className="text-[12px] leading-relaxed text-amber-700">
              <span className="font-semibold">Not included:</span> {notIncludedNote}
            </p>
          </div>
        )}

        <div className="space-y-2">
          <Button
            type="button"
            variant="primary"
            size="lg"
            className="w-full justify-center"
            onClick={onEnableClick}
          >
            Enable {title}
          </Button>
          <p className="text-center text-xs text-zinc-400">You can disable at any time.</p>
        </div>
      </div>
    </div>
  );
}

export function AddOnDisabledPage({
  title,
  description,
  what,
  features,
  useCases,
  whyFilOne,
  enableCard,
  onEnable,
}: AddOnDisabledPageProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <div className="px-10 py-12 pb-20">
        <div className="flex items-start gap-12">

          {/* ── Left: scrollable content ── */}
          <div className="flex-1 min-w-0 space-y-20">

            {/* Hero */}
            <div>
              <Heading tag="h1" size="2xl" description={description} className="mb-10">
                <span className="inline-flex items-center gap-2.5">
                  {title}
                  <Badge color="grey" size="sm" strength="strong">
                    Not enabled
                  </Badge>
                </span>
              </Heading>

              <FeaturePills features={features} />

              <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                Overview
              </p>
              <p className="text-base leading-relaxed text-zinc-600">{what}</p>
            </div>

            {/* Common use cases */}
            <UseCasesSection useCases={useCases} />

            {/* Why Fil One */}
            <WhyFilOneSection items={whyFilOne} />

          </div>

          {/* ── Right: sticky enable card ── */}
          <div className="w-80 flex-shrink-0 sticky top-8">
            <EnableCard
              title={title}
              headline={enableCard.headline}
              subline={enableCard.subline}
              inclusions={enableCard.inclusions}
              notIncludedNote={enableCard.notIncludedNote}
              onEnableClick={() => setConfirmOpen(true)}
            />
          </div>

        </div>
      </div>

      {/* Confirmation modal */}
      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} size="sm">
        <ModalHeader onClose={() => setConfirmOpen(false)}>
          Enable {title}?
        </ModalHeader>
        <ModalBody>
          <p className="text-sm text-zinc-600 mb-4">
            Enabling this add-on will add a usage-based fee to your monthly Fil One invoice.
          </p>
          <ul className="space-y-2 mb-4">
            {enableCard.inclusions.map((item) => (
              <li key={item} className="flex items-center gap-2.5 text-sm text-zinc-600">
                <CheckIcon size={11} weight="bold" className="text-zinc-400 flex-shrink-0" />
                {item}
              </li>
            ))}
          </ul>
          {enableCard.notIncludedNote && (
            <p className="text-xs text-zinc-400">{enableCard.notIncludedNote}</p>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" size="md" onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button variant="primary" size="md" onClick={() => { setConfirmOpen(false); onEnable(); }}>Enable</Button>
        </ModalFooter>
      </Modal>
    </>
  );
}
