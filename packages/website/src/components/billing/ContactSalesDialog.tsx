import { useCallback, useEffect, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import { PaperPlaneTiltIcon } from '@phosphor-icons/react/dist/ssr';

import { Modal, ModalBody, ModalFooter, ModalHeader } from '../Modal';
import { Input } from '../Input';
import { Textarea } from '../TextArea';
import { Button } from '../Button';
import { Spinner } from '../Spinner';
import { useToast } from '../Toast';
import { getMe } from '../../lib/api.js';
import { submitContactSalesForm } from '../../lib/hubspot.js';
import { queryKeys, ME_STALE_TIME } from '../../lib/query-client.js';

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
    <Modal open={open} onClose={handleClose} size="sm">
      <ModalHeader
        description="Tell us about your use case and we'll get back to you with Business plan details."
        onClose={submitting ? undefined : handleClose}
      >
        Contact sales
      </ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-4">
          <div className="flex gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <label
                htmlFor="contact-name"
                className="text-xs font-medium text-(--color-paragraph-text)"
              >
                Name
              </label>
              <Input
                id="contact-name"
                value={name}
                onChange={(v) => {
                  setName(v);
                  if (v.trim()) setNameError(false);
                }}
                invalid={nameError}
                placeholder=""
              />
              {nameError && <p className="text-xs text-red-500">Name is required</p>}
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <label
                htmlFor="contact-company"
                className="text-xs font-medium text-(--color-paragraph-text)"
              >
                Company
              </label>
              <Input
                id="contact-company"
                value={company}
                onChange={setCompany}
                placeholder="Acme Inc."
              />
            </div>
          </div>

          <p className="text-xs text-(--color-paragraph-text-subtle)">
            We&apos;ll reply to your account email address.
          </p>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="contact-message"
              className="flex items-center gap-1.5 text-xs font-medium text-(--color-paragraph-text)"
            >
              Message
              <span className="font-normal text-(--color-paragraph-text-subtle)">(optional)</span>
            </label>
            <Textarea
              id="contact-message"
              value={message}
              onChange={setMessage}
              rows={3}
              placeholder="Tell us about your storage needs, expected volume, or any questions…"
            />
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={handleClose} disabled={submitting}>
          Back
        </Button>
        <Button
          variant="primary"
          icon={submitting ? undefined : PaperPlaneTiltIcon}
          onClick={() => void handleSubmit()}
          disabled={submitting}
          className="flex-1"
        >
          {submitting ? (
            <span className="flex items-center gap-2">
              <Spinner ariaLabel="Sending" size={14} />
              Sending…
            </span>
          ) : (
            'Send message'
          )}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
