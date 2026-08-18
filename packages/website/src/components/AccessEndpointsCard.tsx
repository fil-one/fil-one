import { Card } from './Card';
import { CopyableField } from './CopyableField';

type AccessEndpointsCardProps = {
  s3Endpoint: string;
  s3Path: string;
  region: string;
  title?: string;
};

/**
 * The read-only S3 connection details for a bucket: endpoint, path, and region,
 * each copyable. Bundles the section heading with a flat Card of CopyableField
 * rows so the "access endpoints" block is defined once rather than reassembled
 * inline at each call site.
 */
export function AccessEndpointsCard({
  s3Endpoint,
  s3Path,
  region,
  title = 'Access endpoints',
}: AccessEndpointsCardProps) {
  return (
    <div>
      <h2 className="mb-3 text-sm font-medium text-zinc-900">{title}</h2>
      <Card shadow={false}>
        <div className="flex flex-col gap-3">
          <CopyableField label="S3 Endpoint" value={s3Endpoint} />
          <CopyableField label="S3 Path" value={s3Path} />
          <CopyableField label="Region" value={region} />
        </div>
      </Card>
    </div>
  );
}
