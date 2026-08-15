// Which stage a script is about to rewrite, and how it proves it.
//
// The stage comes from `--stage` alone. `.sst/stage` is not consulted: it holds
// whatever `sst dev` last wrote, it is absent on a fresh clone, and
// `sst shell --stage X` does not update it — so a script that read it would
// reject every documented staging run and silently target somebody's personal
// stack on a bare invocation.
//
// The flag is not trusted either. `ensureSstShell` forwards it to
// `sst shell --stage <name>`, and `assertStageResources` then asserts that the
// resource names SST resolved carry `filone-<stage>-`, which is the only
// evidence in the process that the credentials and tables belong to the stage
// the banner is about to name. Same guard as bin/reset-region-provisioning.ts.

import { execFileSync } from 'node:child_process';

/**
 * Re-exec this script under `sst shell --stage <stage>` when SST resources are
 * not in the environment, then exit. The `--` keeps `sst shell` from parsing
 * our own flags as its own, and `pnpm exec` (not `pnpx`) runs the workspace's
 * own sst instead of downloading a fresh copy.
 */
export function ensureSstShell(stage: string, scriptPath: string, argv: readonly string[]): void {
  if (process.env.SST_RESOURCE_App) return;

  execFileSync(
    'pnpm',
    ['exec', 'sst', 'shell', '--stage', stage, '--', 'node', scriptPath, ...argv],
    { stdio: 'inherit' },
  );
  process.exit(0);
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
