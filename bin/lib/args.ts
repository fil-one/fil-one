// Command-line parsing shared by the org-conversion scripts: the flags both of
// them take, the usage block, and the argv tail that ./stage.ts forwards
// through the `sst shell` re-exec.
//
// `--stage` is required and has no default. A script that targets whichever
// stage happens to be lying around writes to the wrong account exactly once.

/** What one script accepts, beyond the flags every one of them takes. */
export interface CliSpec {
  /** How the script is invoked, e.g. `./bin/convert-orgs-to-orgtable.ts`. */
  script: string;
  /** Extra boolean flags, e.g. `--verify`. */
  flags?: readonly string[];
  /** One line per flag worth explaining, printed under the usage line. */
  help?: readonly string[];
}

export interface Cli {
  /** The stage named by `--stage`, before any resource has confirmed it. */
  stage: string;
  /** True only when `--execute` was passed and `--dry-run` was not. */
  execute: boolean;
  /** Whether one of the spec's extra flags was passed. */
  flag(name: string): boolean;
  /** The arguments to forward when re-execing under `sst shell`. */
  argv: readonly string[];
}

/** Accepted by every script here, so a caller's muscle memory works on all of them. */
const SHARED_FLAGS = ['--execute', '--dry-run'] as const;

const RUNBOOK = 'docs/OrgConversionRunbook.md';

export function parseCli(spec: CliSpec): Cli {
  const argv = process.argv.slice(2);
  const usageLine = usage(spec);

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp(spec, usageLine);
    process.exit(0);
  }

  const known = new Set<string>([...SHARED_FLAGS, ...(spec.flags ?? [])]);
  const { stage, passed } = read(argv, known, usageLine);

  return {
    stage,
    // --dry-run is accepted so the flag from the other bin/ migrations never
    // reads as "execute"; a run carrying both stays a dry run.
    execute: passed.has('--execute') && !passed.has('--dry-run'),
    flag: (name: string) => passed.has(name),
    argv,
  };
}

function usage(spec: CliSpec): string {
  const extras = (spec.flags ?? []).map((flag) => ` [${flag}]`).join('');
  return `Usage: ${spec.script} --stage <name> [--execute]${extras}`;
}

function printHelp(spec: CliSpec, usageLine: string): void {
  console.log(usageLine);
  console.log('  --stage <name>  Required. The stage to read and write, e.g. staging.');
  console.log('  --execute       Apply the plan. Dry run by default.');
  for (const line of spec.help ?? []) console.log(`  ${line}`);
  console.log(`Runbook: ${RUNBOOK}`);
}

function read(
  argv: readonly string[],
  known: ReadonlySet<string>,
  usageLine: string,
): { stage: string; passed: Set<string> } {
  const passed = new Set<string>();
  let stage: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg !== '--stage') {
      if (!known.has(arg)) fail(`Unrecognized argument: ${arg}`, usageLine);
      passed.add(arg);
      continue;
    }
    const value = argv[++i];
    if (!value || value.startsWith('--')) fail('Missing value for --stage.', usageLine);
    stage = value;
  }

  if (!stage) fail('Missing required --stage.', usageLine);
  return { stage, passed };
}

function fail(message: string, usageLine: string): never {
  console.error(message);
  console.error(usageLine);
  console.error(`Runbook: ${RUNBOOK}`);
  process.exit(1);
}
