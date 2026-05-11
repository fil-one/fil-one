import { useCallback, useRef, useState } from 'react';
import { useToast } from '../components/Toast/index.js';
import { batchPresign } from './use-presign.js';

export type UploadStep = 'idle' | 'uploading' | 'done';

export type UseFileUploadOptions = {
  bucketName: string;
  /** Tags to include in the upload metadata. Read at upload time. */
  tags?: string[];
  onSuccess?: (key: string, file: File) => void;
};

export function useFileUpload({ bucketName, tags, onSuccess }: UseFileUploadOptions) {
  const { toast } = useToast();

  const [uploadStep, setUploadStep] = useState<UploadStep>('idle');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [objectName, setObjectName] = useState('');
  const [objectDescription, setObjectDescription] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const userEditedName = useRef(false);

  const reset = useCallback(() => {
    setUploadStep('idle');
    setSelectedFile(null);
    setObjectName('');
    setObjectDescription('');
    setUploadProgress(0);
    userEditedName.current = false;
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      if (!userEditedName.current) {
        setObjectName(file.name);
      }
    }
  }, []);

  const handleObjectNameChange = useCallback((value: string) => {
    userEditedName.current = true;
    setObjectName(value);
  }, []);

  const handleUpload = useCallback(async () => {
    if (!selectedFile || !objectName.trim()) return;
    setUploadStep('uploading');
    setUploadProgress(0);

    try {
      const key = objectName.trim();
      const contentType = selectedFile.type || 'application/octet-stream';

      const description = objectDescription.trim() || undefined;
      const { items } = await batchPresign([
        {
          op: 'putObject',
          bucket: bucketName,
          key,
          contentType,
          fileName: selectedFile.name,
          ...(description && { description }),
          ...(tags && tags.length > 0 && { tags }),
        },
      ]);
      const { url: presignedUrl, method: presignedMethod } = items[0];
      setUploadProgress(1);

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            // Never drop below 1% — we already showed progress for the presign step
            setUploadProgress(Math.max(1, Math.round((e.loaded / e.total) * 100)));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('Upload failed'));
        xhr.open(presignedMethod, presignedUrl);
        xhr.setRequestHeader('Content-Type', contentType);
        xhr.send(selectedFile);
      });

      setUploadProgress(100);
      setUploadStep('done');
      toast.success(`${selectedFile.name} uploaded successfully`);
      onSuccess?.(key, selectedFile);
    } catch (err) {
      console.error('Upload failed:', err);
      reset();
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    }
  }, [selectedFile, objectName, objectDescription, bucketName, tags, toast, onSuccess, reset]);

  return {
    uploadStep,
    selectedFile,
    objectName,
    objectDescription,
    uploadProgress,
    fileInputRef,
    setObjectDescription,
    handleFileSelect,
    handleObjectNameChange,
    handleUpload,
    reset,
  };
}
