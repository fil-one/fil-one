import { useState } from 'react';

import { errorMessageOf } from './api.js';

type ImageRules = { contentTypes: readonly string[]; maxBytes: number; noun: string };

function validateImageFile(
  file: File,
  { contentTypes, maxBytes, noun }: ImageRules,
): string | null {
  if (!contentTypes.includes(file.type)) {
    return `${noun} must be a PNG, JPEG, or WebP image.`;
  }
  if (file.size > maxBytes) {
    return `${noun} must be under ${Math.floor(maxBytes / (1024 * 1024))}MB.`;
  }
  return null;
}

type ImageUploadState = { uploading: boolean; error: string | null };

/**
 * Send `file` to a presigned POST policy, as the multipart form S3 wants: the
 * policy's fields first, the file last. Both presign endpoints sign a POST, so
 * S3 itself enforces the size ceiling and the unclaimed tag they bind.
 */
async function sendToPresignedUpload(
  file: File,
  uploadUrl: string,
  fields: Record<string, string>,
): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('file', file);
  return fetch(uploadUrl, { method: 'POST', body: form });
}

/**
 * Validate a picked image, presign an upload, send the file to it, then hand
 * `onUploaded` the URL it can be read back from.
 *
 * `onUploaded` runs inside the same try/catch as the upload, so a rejection from
 * it (a save call failing, say) surfaces through `error` exactly like a failed
 * upload does.
 */
export function useImageUpload({
  presign,
  onUploaded,
  errorFallback,
  ...rules
}: ImageRules & {
  presign: (
    contentType: string,
  ) => Promise<{ uploadUrl: string; fields: Record<string, string>; url: string }>;
  onUploaded: (url: string) => Promise<void> | void;
  errorFallback: string;
}): ImageUploadState & { pick: (file: File) => Promise<void>; reset: () => void } {
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function pick(file: File): Promise<void> {
    const validationError = validateImageFile(file, rules);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const { uploadUrl, fields, url } = await presign(file.type);
      const uploadResponse = await sendToPresignedUpload(file, uploadUrl, fields);
      if (!uploadResponse.ok) throw new Error('Upload failed');
      await onUploaded(url);
    } catch (err) {
      setError(errorMessageOf(err, errorFallback));
    } finally {
      setUploading(false);
    }
  }

  function reset(): void {
    setError(null);
    setUploading(false);
  }

  return { error, uploading, pick, reset };
}
