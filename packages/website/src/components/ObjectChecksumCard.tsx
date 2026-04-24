import { CopyableField } from './CopyableField';

const CHECKSUM_ALGORITHM_LABELS: Record<string, string> = {
  sha256: 'SHA-256',
  sha1: 'SHA-1',
  crc32: 'CRC32',
  crc32c: 'CRC32C',
  crc64nvme: 'CRC64NVME',
};

export type ObjectChecksumCardProps = {
  checksums: Record<string, string> | undefined;
};

export function ObjectChecksumCard({ checksums }: ObjectChecksumCardProps) {
  const entry = Object.entries(checksums ?? {})[0];
  const algorithm = entry
    ? (CHECKSUM_ALGORITHM_LABELS[entry[0]] ?? entry[0].toUpperCase())
    : undefined;
  const value = entry?.[1];

  return (
    <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-medium text-zinc-900">Checksum</h2>
      <p className="mt-1 mb-4 text-xs text-zinc-500">
        {`Verified at upload. Use this value to confirm the file hasn't been corrupted or tampered with.`}
      </p>
      {entry && value !== undefined ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between py-1">
            <span className="text-[13px] text-zinc-500">Algorithm</span>
            <span className="font-mono text-xs text-zinc-900">{algorithm}</span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-[13px] text-zinc-500">Value</span>
            <CopyableField label="" value={value} />
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-zinc-400">No checksum recorded for this object.</p>
      )}
    </div>
  );
}
