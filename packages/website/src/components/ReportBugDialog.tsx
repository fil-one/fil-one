import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Sentry from '@sentry/react';

import { Button } from './Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { TextArea } from './TextArea';
import { useToast } from './Toast';
import { getMe } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';

export type ReportBugDialogProps = {
  open: boolean;
  onClose: () => void;
};

/**
 * Send a bug report.
 *
 * The description goes to Sentry as user feedback (`captureFeedback`), which is
 * where the console's errors already land, so a report arrives beside the
 * technical context of the session rather than needing an endpoint of its own.
 * The signed-in name and address ride along when we have them, so a report can
 * be answered.
 */
export function ReportBugDialog({ open, onClose }: ReportBugDialogProps) {
  const { toast } = useToast();
  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: () => getMe() });

  const [message, setMessage] = useState('');

  // Reopening starts from an empty field rather than whatever was last typed and
  // abandoned.
  useEffect(() => {
    if (open) setMessage('');
  }, [open]);

  const send = useMutation({
    mutationFn: async (text: string) => {
      Sentry.captureFeedback({
        message: text,
        ...(me?.name ? { name: me.name } : {}),
        ...(me?.email ? { email: me.email } : {}),
      });
    },
    onSuccess: () => {
      toast.success('Thanks, your report is on its way');
      onClose();
    },
    onError: () => {
      toast.error('We could not send that report. Please try again.');
    },
  });

  const canSend = message.trim().length > 0 && !send.isPending;

  return (
    <Modal
      open={open}
      onClose={send.isPending ? () => {} : onClose}
      size="md"
      testId="report-bug-dialog"
    >
      <ModalHeader onClose={send.isPending ? undefined : onClose}>Send feedback</ModalHeader>
      <ModalBody>
        <TextArea
          id="report-bug-message"
          aria-label="Describe the issue"
          value={message}
          onChange={setMessage}
          rows={5}
          disabled={send.isPending}
          placeholder="Describe the issue"
          autoFocus
        />
        <p className="mt-3 text-xs text-(--color-paragraph-text)">
          This report includes your description, your name and email, and technical details from
          your current session, so we can look into it.
        </p>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="md" onClick={onClose} disabled={send.isPending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={() => send.mutate(message.trim())}
          disabled={!canSend}
        >
          {send.isPending ? 'Sending...' : 'Send'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
