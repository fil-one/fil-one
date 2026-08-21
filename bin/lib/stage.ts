// Which stage a script is about to rewrite, and how it proves it.
//
// The stage comes from `--stage` alone. `.sst/stage` is not consulted: it holds
// whatever `sst dev` last wrote, it is absent on a fresh clone, and it would
// silently target somebody's personal stack on a bare invocation.
//
// The flag is not trusted either. `resolveStageTables` reads the physical
// table names out of `sst state export --stage <name>`, and
// `assertStageResources` then asserts those names carry `filone-<stage>-`,
// which is the only evidence in the process that the state and tables belong
// to the stage the banner is about to name. Same guard as
// bin/reset-region-provisioning.ts.

import { execFileSync } from 'node:child_process';

/**
 * Physical DynamoDB table names for a stage, read from `sst state export`.
 *
 * Not `sst shell`: the shell cannot evaluate pulumi providers against
 * production, so a `Resource.*` binding only works on stages a dev machine can
 * fully resolve. Exported state is data, and works everywhere — the same
 * pattern as bin/rag-access.ts and bin/aurora-preview-url.ts. AWS calls then
 * use the caller's ambient credentials.
 *
 * `tables` maps a label to its state URN suffix — SST names a table component's
 * pulumi resource `<LogicalName>Table`, so `UserInfoTable` is found by
 * `::UserInfoTableTable`.
 */
export function resolveStageTables<K extends string>(
  stage: string,
  tables: Record<K, string>,
): Record<K, string> {
  const json = execFileSync('pnpm', ['exec', 'sst', 'state', 'export', '--stage', stage], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const resources: Array<{ type: string; urn: string; outputs?: { name?: string } }> =
    JSON.parse(json).latest?.resources ?? [];

  const resolved = {} as Record<K, string>;
  for (const [label, urnSuffix] of Object.entries(tables) as [K, string][]) {
    const table = resources.find(
      (resource) =>
        resource.type === 'aws:dynamodb/table:Table' && resource.urn.endsWith(urnSuffix),
    );
    if (!table?.outputs?.name) {
      console.error(
        `No ${label} (urn suffix "${urnSuffix}") in the exported state for stage "${stage}". ` +
          'Is the stage deployed, and does it contain the table?',
      );
      process.exit(1);
    }
    resolved[label] = table.outputs.name;
  }
  return resolved;
}

/**
 * Assert every resolved resource name belongs to the stage that was asked for.
 *
 * SST default-names resources `filone-<stage>-<logical name>`, so a name that
 * does not carry the prefix means the shell resolved a different stage than the
 * flag claimed — the run stops before it reads, let alone writes.
 */
export function assertStageResources(stage: string, resources: Record<string, string>): void {
  const prefix = `filone-${stage}-`;
  const mismatched = Object.entries(resources).filter(([, name]) => !name.includes(prefix));
  if (mismatched.length === 0) return;

  console.error(`Stage mismatch: --stage "${stage}" but SST resolved:`);
  for (const [label, name] of mismatched) console.error(`  ${label}: ${name}`);
  console.error(`Every name must contain "${prefix}". Nothing was read or written.`);
  process.exit(1);
}

/**
 * The region a stage's tables live in — mirrors the region logic in
 * sst.config.ts `app()`. Ambient AWS_REGION is not trusted for staging and
 * production, whose home region is fixed.
 */
export function awsRegionForStage(stage: string): string {
  if (stage === 'staging' || stage === 'production') return 'us-east-2';
  return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2';
}
