import { Link } from '@tanstack/react-router';
import { CaretRightIcon } from '@phosphor-icons/react/dist/ssr';
import { getRegionLabel, listBucketsUnavailableMessage } from '@filone/shared';
import type { S3Region } from '@filone/shared';

import { Alert } from './Alert';
import { Breadcrumb } from './Breadcrumb';
import { Card } from './Card';
import { RegionFlag } from './RegionFlag';

/**
 * Asks which bucket a link without a region meant. Bucket names are unique per
 * region only, so the same name can exist in several, and opening one of them
 * on a guess could aim the bucket's destructive actions at the wrong one.
 */
export function BucketRegionChooser({
  bucketName,
  regions,
  unavailableRegions,
}: {
  bucketName: string;
  regions: S3Region[];
  unavailableRegions: S3Region[];
}) {
  return (
    <div className="px-5 pt-6 sm:px-8 lg:px-10 lg:pt-10">
      <Breadcrumb items={[{ label: 'Buckets', href: '/buckets' }, { label: bucketName }]} />
      <div className="mt-4 flex flex-col gap-4">
        {/* Amber, as on the buckets page: the listing answered, just not in full. */}
        {unavailableRegions.length > 0 && (
          <Alert
            variant="amber"
            assertive={false}
            title={listBucketsUnavailableMessage(unavailableRegions)}
            description="A bucket by this name there is not listed below."
          />
        )}
        <Card padding="none" className="text-ui">
          <div className="border-b border-zinc-200 px-5 py-4">
            <p className="font-medium text-zinc-900">Choose a region</p>
            <p className="mt-0.5 text-zinc-500">
              Bucket names are unique per region. Choose the region of the bucket to open.
            </p>
          </div>
          <ul className="divide-y divide-zinc-200" data-testid="bucket-region-choices">
            {regions.map((region) => (
              <li key={region}>
                <Link
                  to="/buckets/$bucketName"
                  params={{ bucketName }}
                  search={{ region }}
                  className="flex items-center gap-2.5 px-5 py-3 text-xs transition-colors duration-150 last:rounded-b-xl hover:bg-zinc-50 focus-visible:brand-outline focus-visible:-outline-offset-2"
                >
                  <RegionFlag region={region} />
                  <span className="flex-1">
                    <span className="block font-medium text-zinc-900">
                      {getRegionLabel(region)}
                    </span>
                    <span className="block text-zinc-500">{region}</span>
                  </span>
                  <CaretRightIcon size={14} aria-hidden="true" className="text-zinc-400" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
