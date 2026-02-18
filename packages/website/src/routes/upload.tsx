import { createRoute } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import type { UploadRequest, UploadResponse } from '@hyperspace/shared';
import { API_URL } from '../env.js';
import { Route as rootRoute } from './__root.js';

type FormStatus =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; uploadId: string }
  | { kind: 'error'; message: string };

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the "data:<mime>;base64," prefix.
      const base64 = result.split(',')[1] ?? '';
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function UploadPage() {
  const [status, setStatus] = useState<FormStatus>({ kind: 'idle' });
  const bucketRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus({ kind: 'submitting' });

    const bucketName = bucketRef.current?.value.trim() ?? '';
    const key = keyRef.current?.value.trim() ?? '';
    const file = fileRef.current?.files?.[0];

    if (!bucketName || !key || !file) {
      setStatus({ kind: 'error', message: 'All fields are required.' });
      return;
    }

    if (!API_URL) {
      setStatus({
        kind: 'error',
        message: 'VITE_API_URL is not configured. Add it to your .env.local file.',
      });
      return;
    }

    try {
      const fileBase64 = await readFileAsBase64(file);
      const body: UploadRequest = {
        bucketName,
        key,
        fileBase64,
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
      };

      const response = await fetch(`${API_URL}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data: UploadResponse = await response.json();

      if (data.status === 'success') {
        setStatus({ kind: 'success', uploadId: data.uploadId });
      } else {
        setStatus({ kind: 'error', message: data.message ?? 'Unknown error' });
      }
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      });
    }
  }

  return (
    <div>
      <h1>Upload File</h1>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '480px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span>Bucket Name</span>
          <input
            ref={bucketRef}
            type="text"
            placeholder="my-filecoin-bucket"
            required
            style={{ padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: '4px' }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span>Key</span>
          <input
            ref={keyRef}
            type="text"
            placeholder="path/to/my-file.txt"
            required
            style={{ padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: '4px' }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span>File</span>
          <input
            ref={fileRef}
            type="file"
            required
            style={{ padding: '0.25rem 0' }}
          />
        </label>

        <button
          type="submit"
          disabled={status.kind === 'submitting'}
          style={{
            padding: '0.6rem 1.2rem',
            backgroundColor: '#3b82f6',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: status.kind === 'submitting' ? 'not-allowed' : 'pointer',
            opacity: status.kind === 'submitting' ? 0.7 : 1,
          }}
        >
          {status.kind === 'submitting' ? 'Uploading…' : 'Upload'}
        </button>
      </form>

      {status.kind === 'success' && (
        <div style={{ marginTop: '1.5rem', padding: '1rem', backgroundColor: '#d1fae5', borderRadius: '4px' }}>
          <strong>Upload recorded.</strong>
          <br />
          Upload ID: <code>{status.uploadId}</code>
        </div>
      )}

      {status.kind === 'error' && (
        <div style={{ marginTop: '1.5rem', padding: '1rem', backgroundColor: '#fee2e2', borderRadius: '4px' }}>
          <strong>Error:</strong> {status.message}
        </div>
      )}
    </div>
  );
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/upload',
  component: UploadPage,
});
