import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CaretDownIcon, CheckIcon, XIcon } from '@phosphor-icons/react/dist/ssr';

import { getMe } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';
import { track } from '../plausible.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { Card } from './Card.js';
import { Heading } from './Heading/Heading.js';
import {
  InterestForm,
  type InterestFormConfig,
  type WaitlistSubmitValues,
} from './InterestForm.js';
import { Modal, ModalHeader } from './Modal/index.js';
import { Overline } from './Overline.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComingSoonFeature = {
  title: string;
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
  hubspotFormGuid: string;
  interestForm: InterestFormConfig;
  /**
   * Overrides how the waitlist form is submitted. Defaults to the Bucket Intelligence
   * (RAG) HubSpot mapping; pages with different fields (e.g. the AI Agent Toolkit) pass
   * their own handler.
   */
  onWaitlistSubmit?: (values: WaitlistSubmitValues) => Promise<void>;
  faqs: ComingSoonFaq[];
};

// ---------------------------------------------------------------------------
// Shared content blocks
// ---------------------------------------------------------------------------

function FeaturePills({ features }: { features: ComingSoonFeature[] }) {
  return (
    <div className="mb-10 flex w-full flex-col items-stretch divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 sm:inline-flex sm:w-auto sm:flex-row sm:divide-x sm:divide-y-0">
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {useCases.map((uc) => (
          <Card key={uc.title} color="subtle" shadow={false}>
            <Overline className="mb-2">{uc.category}</Overline>
            <p className="mb-1.5 text-sm font-semibold text-zinc-900">{uc.title}</p>
            <p className="text-sm leading-relaxed text-zinc-500">{uc.description}</p>
          </Card>
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
      <div className="grid grid-cols-1 gap-x-12 gap-y-8 sm:grid-cols-2">
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
  inclusions,
  onJoinClick,
}: {
  headline: string;
  subline: string;
  inclusions: string[];
  onJoinClick: () => void;
}) {
  return (
    <Card padding="none" className="overflow-hidden">
      {/* Header */}
      <div className="flex flex-col gap-1.5 border-b border-zinc-200 bg-zinc-50 px-6 pb-5 pt-6">
        <Overline>Early access</Overline>
        <span className="text-xl font-medium text-zinc-900">{headline}</span>
        <p className="text-xs leading-relaxed text-zinc-500">{subline}</p>
      </div>

      {/* Inclusions + CTA */}
      <div className="flex flex-col gap-4 p-6">
        <ul className="flex flex-col gap-2.5">
          {inclusions.map((item) => (
            <li key={item} className="flex items-center gap-2.5 text-sm text-zinc-500">
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
    </Card>
  );
}

function AccordionItem({ question, answer }: ComingSoonFaq) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="border-b border-zinc-100 last:border-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full cursor-pointer items-center justify-between gap-4 py-4 text-left group"
      >
        <span className="text-sm font-medium text-zinc-900 group-hover:text-zinc-600 transition-colors duration-150 motion-reduce:transition-none">
          {question}
        </span>
        <CaretDownIcon
          size={14}
          className={`flex-shrink-0 text-zinc-400 group-hover:text-zinc-500 transition-all duration-200 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <p id={panelId} hidden={!open} className="pb-4 text-sm leading-relaxed text-zinc-500">
        {answer}
      </p>
    </div>
  );
}

function WaitlistSuccess({ title, onClose }: { title: string; onClose: () => void }) {
  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: () => getMe() });

  return (
    <div className="relative px-8 pb-10 pt-14">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600"
      >
        <XIcon size={18} />
      </button>

      <div className="flex flex-col items-center text-center">
        <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-full bg-brand-100 ring-4 ring-brand-50">
          <CheckIcon size={20} weight="bold" className="text-brand-700" />
        </div>

        <Heading tag="h3" size="sm" className="text-zinc-900">
          You're on the list
        </Heading>
        <p className="mt-2 max-w-[19rem] text-sm leading-relaxed text-zinc-500">
          {me?.email ? (
            <>
              We'll reach out at <span className="font-medium text-zinc-700">{me.email}</span> when{' '}
              {title} is ready for early access.
            </>
          ) : (
            <>We'll reach out when {title} is ready for early access.</>
          )}
        </p>

        <Button type="button" variant="primary" size="md" className="mt-8" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
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
  hubspotFormGuid,
  interestForm,
  onWaitlistSubmit,
  faqs,
}: ComingSoonPageProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  function openModal() {
    setSubmitted(false);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
  }

  return (
    <>
      <div className="px-4 py-8 sm:px-6 lg:px-10 lg:py-12 lg:pb-20">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-12">
          {/* Hero (col 1, row 1) */}
          <div className="lg:col-start-1 lg:row-start-1">
            <Heading tag="h1" size="2xl" description={description} className="mb-10">
              <span className="inline-flex items-center gap-2.5">
                {title}
                <Badge color="grey" size="sm" strength="strong">
                  Coming Soon
                </Badge>
              </span>
            </Heading>

            <FeaturePills features={features} />
          </div>

          {/* Sticky card (col 2, spans both rows so it aligns with the title) */}
          <div className="w-full lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:sticky lg:top-8">
            <PricingCard
              headline={pricing.headline}
              subline={pricing.subline}
              inclusions={pricing.inclusions}
              onJoinClick={() => {
                track('Waitlist CTA clicked', { props: { page: title } });
                openModal();
              }}
            />
          </div>

          {/* Scrollable content (col 1, row 2) */}
          <div className="min-w-0 space-y-12 lg:col-start-1 lg:row-start-2 lg:space-y-20">
            {/* Overview */}
            <div>
              <Overline className="mb-2">Overview</Overline>
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
        </div>
      </div>

      {/* ── Waitlist modal ── */}
      <Modal open={modalOpen} onClose={closeModal} size="md">
        {submitted ? (
          <WaitlistSuccess title={title} onClose={closeModal} />
        ) : (
          <>
            <ModalHeader
              onClose={closeModal}
              description="Helps us prioritise the first wave of alpha invitations."
            >
              Tell us about your use case
            </ModalHeader>
            <InterestForm
              config={interestForm}
              formGuid={hubspotFormGuid}
              onSubmit={onWaitlistSubmit}
              onSubmitted={() => {
                track('Waitlist submitted', { props: { page: title } });
                setSubmitted(true);
              }}
              onCancel={closeModal}
            />
          </>
        )}
      </Modal>
    </>
  );
}
