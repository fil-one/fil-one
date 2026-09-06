import { useState } from 'react';

import { errorMessageOf } from './api.js';

/**
 * The one shape both `OrgLogoPicker` and `ProfileAvatarPicker` used to
 * hand-roll on their own: validate a picked file, presign an upload, PUT the
 * file to it, then hand the caller the result to do whatever it does after
 * (save it immediately, or just hold it until a dialog's own Save). A bug fix
 * to any of that — a non-2xx PUT, a retry, the MIME check — now lands once.
 */
export function validateImageFile(
  file: File,
  {
    contentTypes,
    maxBytes,
    noun,
  }: { contentTypes: readonly string[]; maxBytes: number; noun: string },
): string | null {
  if (!contentTypes.includes(file.type)) {
    return `${noun} must be a PNG, JPEG, or WebP image.`;
  }
  if (file.size > maxBytes) {
    return `${noun} must be under ${Math.floor(maxBytes / (1024 * 1024))}MB.`;
  }
  return null;
}

export type ImageUploadState = { uploading: boolean; error: string | null };

/**
 * `presign` returns both the URL to PUT the file to and whatever value the
 * caller's own `onUploaded` needs (the read-back URL, typically) — kept
 * generic rather than a fixed `{ uploadUrl, url }` shape, since the two
 * presign endpoints this wraps name that second field differently
 * (`logoUrl`, `pictureUrl`) and a caller reading its own domain's name reads
 * better than a renamed generic one.
 *
 * `onUploaded` runs inside the same try/catch as the PUT, so a rejection from
 * it (a save call failing, say) surfaces through `error` exactly like a
 * failed upload does — `ProfileAvatarPicker` needs that: its "upload" is not
 * done until the profile save it triggers lands too.
 */
export function useImageUpload<T>({
  validate,
  presign,
  onUploaded,
  errorFallback,
}: {
  validate: (file: File) => string | null;
  presign: (contentType: string) => Promise<{ uploadUrl: string; result: T }>;
  onUploaded: (result: T) => Promise<void> | void;
  errorFallback: string;
}): ImageUploadState & { pick: (file: File) => Promise<void>; reset: () => void } {
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function pick(file: File): Promise<void> {
    const validationError = validate(file);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const { uploadUrl, result } = await presign(file.type);
      const putResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putResponse.ok) throw new Error('Upload failed');
      await onUploaded(result);
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
