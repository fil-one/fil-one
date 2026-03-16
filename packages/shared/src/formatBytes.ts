const SIZES = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const SHORT_SIZES = ['B', 'K', 'M', 'G', 'T'] as const;
const K = 1000;

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(K));
  return `${parseFloat((bytes / Math.pow(K, i)).toFixed(1))} ${SIZES[i]}`;
}

export function formatBytesShort(bytes: number): string {
  if (bytes === 0) return '0';
  const i = Math.floor(Math.log(bytes) / Math.log(K));
  return `${parseFloat((bytes / Math.pow(K, i)).toFixed(0))}${SHORT_SIZES[i]}`;
}
