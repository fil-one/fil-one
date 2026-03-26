import { useCallback, useEffect, useState } from 'react';

import { Modal, ModalBody, ModalFooter, ModalHeader } from '../Modal';
import { Input } from '../Input';
import { TextArea } from '../TextArea';
import { useToast } from '../Toast';
import { getMe } from '../../lib/api.js';
import { submitContactSalesForm } from '../../lib/hubspot.js';

type ContactSalesDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function ContactSalesDialog({ open, onClose }: ContactSalesDialogProps) {
  const { toast } = useToast();

  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [nameError, setNameError] = useState(false);

  // Fetch user info when dialog opens
  useEffect(() => {
    if (!open) return;
    getMe()
      .then((me) => {
        if (me.email) setEmail(me.email);
        if (me.name) setName(me.name);
        if (me.orgName) setCompany(me.orgName);
      })
      .catch(() => {
        // Non-blocking — email/name prefill is optional
      });
  }, [open]);

  const resetForm = useCallback(() => {
    setName('');
    setCompany('');
    setMessage('');
    setEmail('');
    setNameError(false);
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
    <Modal open={open} onClose={handleClose} size="sm">
      <ModalHeader onClose={handleClose}>Contact sales</ModalHeader>
      <ModalBody>
        <p className="text-[13px] text-[#677183] mb-4">
          Tell us about your use case and we&apos;ll get back to you with Business plan details.
        </p>

        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-xs font-medium text-[#677183] mb-2">Name</label>
            <Input
              value={name}
              onChange={(v) => {
                setName(v);
                if (v.trim()) setNameError(false);
              }}
              placeholder=""
              className={nameError ? 'border-red-400' : ''}
            />
            {nameError && <p className="text-xs text-red-500 mt-1">Name is required</p>}
          </div>
          <div className="flex-1">
            <label className="block text-xs font-medium text-[#677183] mb-2">Company</label>
            <Input value={company} onChange={setCompany} placeholder="" />
          </div>
        </div>

        <p className="text-xs text-[#677183] mt-3 mb-3">
          We&apos;ll reply to your account email address.
        </p>

        <div>
          <label className="block text-xs font-medium text-[#677183] mb-2">
            Message <span className="text-[#677183]/60">(optional)</span>
          </label>
          <TextArea
            value={message}
            onChange={setMessage}
            rows={3}
            placeholder="Tell us about your storage needs, expected volume, or any questions…"
          />
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          type="button"
          onClick={handleClose}
          disabled={submitting}
          className="rounded-lg border border-[#e1e4ea] px-4 py-2 text-[13px] font-medium text-[#14181f] transition-colors hover:bg-zinc-50 disabled:opacity-50"
        >
          Back
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="flex-1 rounded-lg bg-gradient-to-r from-[#0066ff] to-[#0052cc] px-4 py-2 text-[13px] font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? 'Sending...' : 'Send message'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
