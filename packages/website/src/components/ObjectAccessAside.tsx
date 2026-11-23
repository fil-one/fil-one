import { getS3Endpoint } from '@filone/shared';
import type { S3Region } from '@filone/shared';

import { CodeBlock } from './CodeBlock';
import { Overline } from './Overline';
import { FILONE_STAGE } from '../env';
import { getObjectCliCommand } from '../lib/object-cli-command.js';

/**
 * How to reach the object from code: a ready-to-run AWS CLI command, and the
 * region's endpoint for any other S3 client, laid out alike. The S3 URI is inside the command
 * and in the header's Copy S3 URI, so it is not printed a third time. Stacked
 * under the cards below `xl`, a sticky column beside them from `xl`, laid out
 * like `InfoAside` but wider, so the command wraps less. `InfoAside` takes a
 * paragraph per item, which cannot hold a code block.
 */
export function ObjectAccessAside({
  bucketName,
  region,
  objectKey,
  versionId,
}: {
  bucketName: string;
  region: S3Region;
  objectKey: string;
  /** The version in the URL, so the command downloads the version on screen. */
  versionId?: string;
}) {
  const endpoint = getS3Endpoint(region, FILONE_STAGE);
  // One line, left to wrap: backslash continuations stranded themselves on lines
  // of their own once the column wrapped them.
  const cliCommand = getObjectCliCommand({ bucketName, objectKey, versionId, endpoint });

  return (
    // xl:pt-5 lines the overline up with the first card's content, under its p-5
    <aside
      aria-labelledby="object-access-heading"
      className="flex w-full max-w-[520px] flex-col gap-3 xl:sticky xl:top-0 xl:w-72 xl:shrink-0 xl:self-start xl:pt-5"
    >
      <Overline>
        <span id="object-access-heading">API access</span>
      </Overline>
      <AsideItem title="Download with the AWS CLI" value={cliCommand} />
      <AsideItem title="Endpoint" value={endpoint} />
    </aside>
  );
}

/**
 * One value to copy, both items alike: a title, then the value in a code block
 * with its copy button inside. Wrapped rather than truncated or scrolled,
 * because a value cut off at the column edge is one nobody can check before
 * pasting.
 */
function AsideItem({ title, value }: { title: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-zinc-900">{title}</span>
      {/* The minimal block has no border, as it expects a card around it. Here it
          sits on the page background, so the border marks out its edge. */}
      <CodeBlock code={value} minimal wrap className="border border-zinc-200" />
    </div>
  );
}
