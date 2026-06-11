import { type FormEvent, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { getMe } from '../lib/api.js';
import { submitWaitlistForm } from '../lib/hubspot.js';
import { queryKeys } from '../lib/query-client.js';
import { Alert } from './Alert.js';
import { Button } from './Button.js';
import { FormField } from './FormField.js';
import { ProvidersMultiSelect } from './ProvidersMultiSelect.js';
import { Select } from './Select.js';
import { Textarea } from './TextArea.js';

export type InterestFormConfig = {
  /** Use-case question. Omit workloadTypes to hide the field entirely. */
  workloadLabel?: string;
  workloadTypes?: string[];
  timelines: string[];
  providersLabel: string;
  providers: string[];
  /** When true, the providers field is a multi-select checkbox group instead of a single dropdown. */
  providersMultiple?: boolean;
  /** Whether to show the "Amount of storage" question. Defaults to true. */
  showStorageAmount?: boolean;
  notesPlaceholder: string;
};

export type WaitlistSubmitValues = {
  formId: string;
  firstName: string;
  lastName: string;
  email: string;
  workload: string;
  providers: string[];
  otherProvider: string;
  timeline: string;
  teamSize: string;
  storageAmount: string;
  notes: string;
};

export function InterestForm({
  config,
  formGuid,
  onSubmit,
  onSubmitted,
  onCancel,
}: {
  config: InterestFormConfig;
  formGuid: string;
  onSubmit?: (values: WaitlistSubmitValues) => Promise<void>;
  onSubmitted: () => void;
  onCancel: () => void;
}) {
  const workloadId = useId();
  const providerId = useId();
  const timelineId = useId();
  const teamSizeId = useId();
  const storageAmountId = useId();
  const notesId = useId();

  const [workload, setWorkload] = useState('');
  const [timeline, setTimeline] = useState('');
  // Providers are always stored as an array so single-select and multi-select share one
  // state shape. In single-select mode the array holds at most one value (see the Select
  // below, which reads selectedProviders[0]); the default submit maps that first value to
  // the RAG `ragProvider` field.
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [otherProvider, setOtherProvider] = useState('');
  const [teamSize, setTeamSize] = useState('');
  const [storageAmount, setStorageAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);

  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: () => getMe() });

  function toggleProvider(value: string) {
    setSelectedProviders((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(false);

    const fullName = me?.name ?? '';
    const spaceIndex = fullName.indexOf(' ');
    const firstName = spaceIndex !== -1 ? fullName.slice(0, spaceIndex) : fullName;
    const lastName = spaceIndex !== -1 ? fullName.slice(spaceIndex + 1) : '';

    const values: WaitlistSubmitValues = {
      formId: formGuid,
      firstName,
      lastName,
      email: me?.email ?? '',
      workload,
      providers: selectedProviders,
      otherProvider,
      timeline,
      teamSize,
      storageAmount,
      notes,
    };

    const submit =
      onSubmit ??
      ((v: WaitlistSubmitValues) =>
        submitWaitlistForm({
          formId: v.formId,
          firstName: v.firstName,
          lastName: v.lastName,
          email: v.email,
          primaryUseCase: v.workload,
          ragProvider: v.providers[0] ?? '',
          timeline: v.timeline,
          teamSize: v.teamSize,
          storageAmount: v.storageAmount,
          notes: v.notes,
        }));

    try {
      await submit(values);
      onSubmitted();
    } catch {
      setSubmitError(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="px-6 py-6">
      <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2">
        {config.workloadTypes && config.workloadTypes.length > 0 && (
          <FormField label={config.workloadLabel ?? 'Primary use case'} htmlFor={workloadId}>
            <Select id={workloadId} value={workload} onChange={setWorkload}>
              <option value="">Select…</option>
              {config.workloadTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </FormField>
        )}

        {!config.providersMultiple && (
          <FormField label={config.providersLabel} htmlFor={providerId}>
            <Select
              id={providerId}
              value={selectedProviders[0] ?? ''}
              onChange={(v) => setSelectedProviders(v ? [v] : [])}
            >
              <option value="">Select…</option>
              {config.providers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </FormField>
        )}

        <FormField label="Timeline" htmlFor={timelineId}>
          <Select id={timelineId} value={timeline} onChange={setTimeline}>
            <option value="">Select…</option>
            {config.timelines.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField label="Team size" htmlFor={teamSizeId}>
          <Select id={teamSizeId} value={teamSize} onChange={setTeamSize}>
            <option value="">Select…</option>
            <option value="Just me">Just me</option>
            <option value="2-10 people">2-10 people</option>
            <option value="11-50 people">11-50 people</option>
            <option value="51+ people">51+ people</option>
          </Select>
        </FormField>

        {config.showStorageAmount !== false && (
          <FormField label="Amount of storage" htmlFor={storageAmountId} className="sm:col-span-2">
            <Select id={storageAmountId} value={storageAmount} onChange={setStorageAmount}>
              <option value="">Select…</option>
              <option value="Less than 25 TB">Less than 25 TB</option>
              <option value="25 - 50 TB">25 - 50 TB</option>
              <option value="50 - 100 TB">50 - 100 TB</option>
              <option value="100 - 150 TB">100 - 150 TB</option>
              <option value="150 - 250 TB">150 - 250 TB</option>
              <option value="250 - 500 TB">250 - 500 TB</option>
              <option value="500 - 1 PB">500 TB - 1 PB</option>
              <option value="More than 1 PB">More than 1 PB</option>
            </Select>
          </FormField>
        )}
      </div>

      {config.providersMultiple && (
        <ProvidersMultiSelect
          label={config.providersLabel}
          providers={config.providers}
          selected={selectedProviders}
          onToggle={toggleProvider}
          otherValue={otherProvider}
          onOtherChange={setOtherProvider}
        />
      )}

      <div className="mt-5">
        <FormField label="Notes" optional htmlFor={notesId}>
          <Textarea
            id={notesId}
            rows={3}
            placeholder={config.notesPlaceholder}
            value={notes}
            onChange={setNotes}
          />
        </FormField>
      </div>

      {submitError && (
        <div className="mt-4">
          <Alert
            variant="red"
            title="Something went wrong"
            description="We couldn't submit your request. Please try again."
          />
        </div>
      )}

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
