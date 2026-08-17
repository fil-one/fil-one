// Command-line parsing shared by the migration scripts: the flags all of them
// take and the usage block.
//
// `--stage` is required and has no default. A script that targets whichever
// stage happens to be lying around writes to the wrong account exactly once.

/** What one script accepts, beyond the flags every one of them takes. */
export interface CliSpec {
  /** How the script is invoked, e.g. `./bin/convert-orgs-to-orgtable.ts`. */
  script: string;
  /** Extra boolean flags, e.g. `--verify`. */
  flags?: readonly string[];
  /** Extra flags that take a value, e.g. `--accept-anomalies <orgId,orgId>`. */
  options?: readonly string[];
  /** One line per flag worth explaining, printed under the usage line. */
  help?: readonly string[];
  /**
   * The procedure this script belongs to, printed on every usage and failure.
   * An operator who mistypes a flag is one who needs the runbook, and the one
   * they need is their own migration's.
   */
  runbook?: string;
}

export interface Cli {
  /** The stage named by `--stage`, before any resource has confirmed it. */
  stage: string;
  /** True only when `--execute` was passed and `--dry-run` was not. */
  execute: boolean;
  /** Whether one of the spec's extra flags was passed. */
  flag(name: string): boolean;
  /** The value given to one of the spec's extra options, if it was passed. */
  option(name: string): string | undefined;
}

/** Accepted by every script here, so a caller's muscle memory works on all of them. */
const SHARED_FLAGS = ['--execute', '--dry-run'] as const;

/** Where a script points when it has nothing better to say. */
const DEFAULT_RUNBOOK = 'docs/OrgConversionRunbook.md';

export function parseCli(spec: CliSpec): Cli {
  const argv = process.argv.slice(2);
  const usageLine = usage(spec);
  const runbook = spec.runbook ?? DEFAULT_RUNBOOK;

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp(spec, usageLine, runbook);
    process.exit(0);
  }

  const known = new Set<string>([...SHARED_FLAGS, ...(spec.flags ?? [])]);
  const valued = new Set<string>(spec.options ?? []);
  const { stage, passed, values } = read(argv, known, valued, { usageLine, runbook });

  return {
    stage,
    // --dry-run is accepted so the flag from the other bin/ migrations never
    // reads as "execute"; a run carrying both stays a dry run.
    execute: passed.has('--execute') && !passed.has('--dry-run'),
    flag: (name: string) => passed.has(name),
    option: (name: string) => values.get(name),
  };
}

function usage(spec: CliSpec): string {
  const extras = [
    ...(spec.flags ?? []).map((flag) => ` [${flag}]`),
    ...(spec.options ?? []).map((option) => ` [${option} <value>]`),
  ].join('');
  return `Usage: ${spec.script} --stage <name> [--execute]${extras}`;
}

function printHelp(spec: CliSpec, usageLine: string, runbook: string): void {
  console.log(usageLine);
  console.log('  --stage <name>  Required. The stage to read and write, e.g. staging.');
  console.log('  --execute       Apply the plan. Dry run by default.');
  for (const line of spec.help ?? []) console.log(`  ${line}`);
  console.log(`Runbook: ${runbook}`);
}

/** What a parse failure prints alongside the message: how to call it, and where it is documented. */
interface Guidance {
  usageLine: string;
  runbook: string;
}

function read(
  argv: readonly string[],
  known: ReadonlySet<string>,
  valued: ReadonlySet<string>,
  guidance: Guidance,
): { stage: string; passed: Set<string>; values: Map<string, string> } {
  const passed = new Set<string>();
  const values = new Map<string, string>();
  let stage: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg !== '--stage' && !valued.has(arg)) {
      if (!known.has(arg)) fail(`Unrecognized argument: ${arg}`, guidance);
      passed.add(arg);
      continue;
    }
    const value = argv[++i];
    if (!value || value.startsWith('--')) fail(`Missing value for ${arg}.`, guidance);
    if (arg === '--stage') stage = value;
    else values.set(arg, value);
  }

  if (!stage) fail('Missing required --stage.', guidance);
  return { stage, passed, values };
}

function fail(message: string, { usageLine, runbook }: Guidance): never {
  console.error(message);
  console.error(usageLine);
  console.error(`Runbook: ${runbook}`);
  process.exit(1);
}
