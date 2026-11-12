import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Sentry from '@sentry/react';
import { ImageIcon, XIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';

import { formatBytes } from '@filone/shared';

import { Button } from './Button';
import { IconButton } from './IconButton';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './Modal';
import { Textarea } from './TextArea';
import { useToast } from './Toast';
import { getMe } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';
import { scrubInviteToken } from '../lib/url-scrub.js';

export type ReportBugDialogProps = {
  open: boolean;
  onClose: () => void;
};

/** The image types a screenshot tool produces, and the extension each is sent with. */
const SCREENSHOT_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
export const SCREENSHOT_MAX_BYTES = 5_000_000;

type Report = { message: string; screenshot: File | null };

/**
 * Send a bug report.
 *
 * The description goes to Sentry as user feedback, which is where the console's
 * errors already land, so a report arrives beside the technical context of the
 * session rather than needing an endpoint of its own. The signed-in name and
 * address ride along when we have them, so a report can be answered. A
 * screenshot, when attached, goes as an attachment on the same event, the way
 * Sentry's own feedback widget sends one.
 *
 * The person picks the screenshot; the console never captures the page itself.
 * The secret access key is on screen once, after a key is created, and an
 * automatic capture at that moment would send it to Sentry, where no scrubbing
 * reaches pixels.
 *
 * `sendFeedback` rather than `captureFeedback`: the latter only queues the event
 * and returns, so a rejected or undelivered report would still read as sent.
 * `sendFeedback` settles once Sentry answers, and the dialog confirms only then;
 * on failure it stays open with the description intact, ready to retry.
 */
export function ReportBugDialog({ open, onClose }: ReportBugDialogProps) {
  const { toast } = useToast();
  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: () => getMe() });

  const [message, setMessage] = useState('');
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  // Reopening starts from an empty report rather than whatever was last typed
  // or attached and abandoned.
  useEffect(() => {
    if (open) {
      setMessage('');
      setScreenshot(null);
    }
  }, [open]);

  const send = useMutation({
    mutationFn: async ({ message: text, screenshot: image }: Report) => {
      const params = {
        message: text,
        // `sendFeedback` records the page it was sent from, and feedback events
        // skip `beforeSend`, so the URL is scrubbed here instead.
        url: scrubInviteToken(window.location.href),
        ...(me?.name ? { name: me.name } : {}),
        ...(me?.email ? { email: me.email } : {}),
      };
      if (!image) {
        await Sentry.sendFeedback(params);
        return;
      }
      await Sentry.sendFeedback(params, {
        attachments: [
          {
            filename: `screenshot.${SCREENSHOT_TYPES[image.type]}`,
            data: new Uint8Array(await image.arrayBuffer()),
            contentType: image.type,
          },
        ],
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

  /** Attaches an image, or says why it can't. Replaces any earlier screenshot. */
  function attach(file: File) {
    if (!Object.hasOwn(SCREENSHOT_TYPES, file.type)) {
      toast.error('Attach a PNG, JPEG or WebP image');
      return;
    }
    if (file.size > SCREENSHOT_MAX_BYTES) {
      toast.error(`Attach an image up to ${formatBytes(SCREENSHOT_MAX_BYTES)}`);
      return;
    }
    setScreenshot(file);
  }

  const canSend = message.trim().length > 0 && !send.isPending;

  return (
    <Modal
      open={open}
      onClose={send.isPending ? () => {} : onClose}
      size="md"
      testId="report-bug-dialog"
    >
      <ModalHeader onClose={send.isPending ? undefined : onClose}>Report a bug</ModalHeader>
      <ModalBody>
        {/* Paste and drop land anywhere in the body, so a screenshot copied to
            the clipboard goes in with the usual shortcut while typing. Text
            pastes are left to the field. */}
        <div
          data-testid="report-bug-drop-area"
          className={clsx(
            'rounded-lg',
            dragging && 'outline-2 outline-offset-4 outline-brand-600 outline-dashed',
          )}
          onPaste={(e) => {
            const image = Array.from(e.clipboardData.files).find((f) =>
              f.type.startsWith('image/'),
            );
            if (!image || send.isPending) return;
            e.preventDefault();
            attach(image);
          }}
          onDragOver={(e) => {
            if (send.isPending || !e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            // Leaving into a child still counts as over the area.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files[0];
            if (file && !send.isPending) attach(file);
          }}
        >
          <Textarea
            id="report-bug-message"
            aria-label="Describe the issue"
            value={message}
            onChange={setMessage}
            rows={5}
            disabled={send.isPending}
            placeholder="Describe the issue"
            autoFocus
          />
          <div className="mt-3">
            {screenshot ? (
              <ScreenshotPreview
                file={screenshot}
                disabled={send.isPending}
                onRemove={() => setScreenshot(null)}
              />
            ) : (
              <ScreenshotPicker disabled={send.isPending} onFile={attach} />
            )}
          </div>
        </div>
        <p className="mt-3 text-xs text-(--color-paragraph-text)">
          This report includes your description, any screenshot you attach, your name and email so
          we can reply, and technical details from your current session so we can look into it.
        </p>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="md" onClick={onClose} disabled={send.isPending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={() => send.mutate({ message: message.trim(), screenshot })}
          disabled={!canSend}
        >
          {send.isPending ? 'Sending...' : 'Send report'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/** The button that opens a file picker, with the other two ways in beside it. */
function ScreenshotPicker({
  disabled,
  onFile,
}: {
  disabled: boolean;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button
        variant="ghost"
        size="sm"
        icon={ImageIcon}
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
      >
        Attach screenshot
      </Button>
      {/* Pasting and dropping a file need a desktop; on touch the button is the way. */}
      <span className="hidden text-xs text-(--color-paragraph-text-subtle) pointer-fine:inline">
        or paste or drop one here
      </span>
      <input
        ref={inputRef}
        type="file"
        accept={Object.keys(SCREENSHOT_TYPES).join(',')}
        aria-label="Screenshot file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so picking the same file again after removing it still fires.
          e.target.value = '';
          if (file) onFile(file);
        }}
        className="hidden"
      />
    </div>
  );
}

/**
 * The attached screenshot: a thumbnail to check what is being sent, its size,
 * and a way to take it off. The reminder sits here, where the image is.
 */
function ScreenshotPreview({
  file,
  disabled,
  onRemove,
}: {
  file: File;
  disabled: boolean;
  onRemove: () => void;
}) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-zinc-200 p-2">
      {src && (
        <img
          src={src}
          alt="Attached screenshot"
          className="h-12 w-16 shrink-0 rounded-md border border-zinc-200 object-cover"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui font-medium text-(--color-text-base)">Screenshot</p>
        <p className="text-xs text-(--color-paragraph-text-subtle)">
          {formatBytes(file.size)} · Check it shows no secret keys
        </p>
      </div>
      <IconButton
        icon={XIcon}
        size="sm"
        aria-label="Remove screenshot"
        onClick={onRemove}
        disabled={disabled}
      />
    </div>
  );
}
