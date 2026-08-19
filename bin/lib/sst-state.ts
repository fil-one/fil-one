// Finding a deployed table without `sst shell`.
//
// The flag scripts beside this one run against production, where `sst shell`
// cannot evaluate pulumi providers. They read the deployed state instead and
// talk to AWS with the operator's ambient credentials, which is why they take a
// stage name rather than trusting whatever the environment happens to hold.
//
// The migration scripts do the opposite — see bin/lib/stage.ts — because they
// need every linked resource, not one table.

import { execFileSync } from 'node:child_process';

interface StateResource {
  type: string;
  urn: string;
  outputs?: { name?: string; arn?: string };
}

/**
 * The real name and region of one deployed DynamoDB table.
 *
 * `urnSuffix` names the SST component's underlying table — a `Dynamo` component
 * called `UserInfoTable` creates a table whose URN ends `::UserInfoTableTable`.
 */
export function findTable(stage: string, urnSuffix: string): { tableName: string; region: string } {
  const json = execFileSync('pnpm', ['exec', 'sst', 'state', 'export', '--stage', stage], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const resources: StateResource[] = JSON.parse(json).latest?.resources ?? [];
  const table = resources.find(
    (r) => r.type === 'aws:dynamodb/table:Table' && r.urn.endsWith(urnSuffix),
  );

  if (!table?.outputs?.name) {
    console.error(`Could not find ${urnSuffix} in SST state for stage "${stage}".`);
    process.exit(1);
  }

  return { tableName: table.outputs.name, region: resolveRegion(stage, table.outputs.arn) };
}

function resolveRegion(stage: string, tableArn: string | undefined): string {
  // The deployment home region is fixed for production/staging (see
  // sst.config.ts); dev stages can deploy anywhere, so read the region from
  // the table ARN (arn:aws:dynamodb:<region>:<account>:table/<name>).
  if (stage === 'production' || stage === 'staging') return 'us-east-2';

  const region = tableArn?.split(':')[3];
  if (!region) {
    console.error(`Could not parse the region from the table ARN: ${tableArn}`);
    process.exit(1);
  }
  return region;
}

/**
 * Stop before any AWS call when no profile is active.
 *
 * Without it the SDK fails late with a `CredentialsProviderError` that says
 * nothing about which login is missing.
 */
export function requireAwsProfile(): void {
  if (process.env.AWS_PROFILE) return;

  console.error(
    'AWS_PROFILE is not set. Log in and activate the profile first (see README.md):\n' +
      '  aws sso login --profile filone\n' +
      '  export AWS_PROFILE=filone',
  );
  process.exit(1);
}
