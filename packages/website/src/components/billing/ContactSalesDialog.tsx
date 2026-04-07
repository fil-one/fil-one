import { useCallback, useEffect, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import { XIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';

import { Modal } from '../Modal';
import { Input } from '../Input';
import { TextArea } from '../TextArea';
import { useToast } from '../Toast';
import { getMe } from '../../lib/api.js';
import { submitContactSalesForm } from '../../lib/hubspot.js';
import { queryKeys, ME_STALE_TIME } from '../../lib/query-client.js';

type ContactSalesDialogProps = {
  open: boolean;
  onClose: () => void;
};

const inputClass =
  '!rounded-[6px] !p-0 !px-[13px] !h-[36px] bg-[#f9fafb] !border-[#e1e4ea] text-[13px]';
const textareaClass =
  '!rounded-[6px] !p-3 !px-3 !py-2 min-h-[80px] bg-[#f9fafb] !border-[#e1e4ea] text-[13px] leading-[19.5px] !resize-none';

export function ContactSalesDialog({ open, onClose }: ContactSalesDialogProps) {
  const { toast } = useToast();

  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [nameError, setNameError] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const { data: me } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
    enabled: open,
  });

  useEffect(() => {
    if (!me || initialized) return;
    if (me.email) setEmail(me.email);
    if (me.name) setName(me.name);
    if (me.orgName) setCompany(me.orgName);
    setInitialized(true);
  }, [me, initialized]);

  const resetForm = useCallback(() => {
    setName('');
    setCompany('');
    setMessage('');
    setEmail('');
    setNameError(false);
    setInitialized(false);
  }, []);

  function handleClose() {
    if (submitting) return;
    resetForm();
    onClose();
  }

  async function handleSubmit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError(true);
      return;
    }

    setSubmitting(true);
    try {
      await submitContactSalesForm({
        name: trimmedName,
        company: company.trim(),
        email,
        message: message.trim() || undefined,
      });
      toast.success("Message sent! We'll be in touch.");
      resetForm();
      onClose();
    } catch {
      toast.error('Failed to send message. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="sm"
      panelClassName="!rounded-[8px] !bg-[#f9fafb] border border-[#e1e4ea] !shadow-[0px_10px_15px_-3px_rgba(0,0,0,0.1),0px_4px_6px_-4px_rgba(0,0,0,0.1)] overflow-clip"
    >
      {/* Close button */}
      <button
        type="button"
        className="absolute top-4 right-4 flex items-center justify-center rounded-[4px] opacity-70 transition-opacity hover:opacity-100"
        onClick={handleClose}
        aria-label="Close"
      >
        <XIcon width={16} height={16} />
      </button>

      {/* Header */}
      <div className="pt-6 px-6 pb-4">
        <h2 className="text-[16px] font-semibold leading-6 tracking-[-0.4px] text-[#14181f]">
          Contact sales
        </h2>
        <p className="mt-1.5 text-[13px] leading-[19.5px] text-[#677183]">
          Tell us about your use case and we&apos;ll get back to you with Business plan details.
        </p>
      </div>

      {/* Form body */}
      <div className="px-6 py-1 flex flex-col gap-3">
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-[12px] font-medium leading-[18px] text-[#677183] mb-2">
              Name
            </label>
            <Input
              value={name}
              onChange={(v) => {
                setName(v);
                if (v.trim()) setNameError(false);
              }}
              placeholder=""
              className={clsx(inputClass, nameError && '!border-red-400')}
            />
            {nameError && <p className="text-xs text-red-500 mt-1">Name is required</p>}
          </div>
          <div className="flex-1">
            <label className="block text-[12px] font-medium leading-[18px] text-[#677183] mb-2">
              Company
            </label>
            <Input
              value={company}
              onChange={setCompany}
              placeholder="Acme Inc."
              className={inputClass}
            />
          </div>
        </div>

        <p className="text-[12px] leading-[18px] text-[#677183]">
          We&apos;ll reply to your account email address.
        </p>

        <div>
          <label className="block text-[12px] font-medium leading-[18px] text-[#677183] mb-2">
            Message <span className="opacity-60">(optional)</span>
          </label>
          <TextArea
            value={message}
            onChange={setMessage}
            rows={3}
            placeholder="Tell us about your storage needs, expected volume, or any questions…"
            className={textareaClass}
          />
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-[#e1e4ea] px-6 pt-[17px] pb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={handleClose}
          disabled={submitting}
          className="flex items-center justify-center h-[36px] rounded-[6px] border border-[#e1e4ea] bg-[#f9fafb] px-[17px] text-[13px] font-medium text-[#14181f] shadow-[0px_1px_2px_0px_rgba(20,24,31,0.03)] transition-colors hover:bg-zinc-50 disabled:opacity-50"
        >
          Back
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="flex flex-1 items-center justify-center h-[36px] rounded-[6px] bg-gradient-to-br from-[#0080ff] to-[#256af4] text-[13px] font-medium text-white shadow-[0px_1px_2px_0px_rgba(0,0,0,0.05)] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? 'Sending...' : 'Send message'}
        </button>
      </div>
    </Modal>
  );
}
