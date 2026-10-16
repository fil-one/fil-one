/**
 * Compares the packages `pnpm test:unit` tests with the packages the CI
 * workflow tests, so a package cannot drop out of CI unnoticed.
 */

export interface WorkspacePackage {
  name: string;
  isRoot: boolean;
  hasTestScript: boolean;
}

export interface CiTestCommand {
  job: string;
  command: string;
}

export interface TestCoverageInput {
  packages: WorkspacePackage[];
  testUnitCommand: string;
  ciTestCommands: CiTestCommand[];
}

/** Returns one message per problem; an empty list means the two sides agree. */
export function findTestCoverageProblems({
  packages,
  testUnitCommand,
  ciTestCommands,
}: TestCoverageInput): string[] {
  const problems: string[] = [];

  const testUnit = selectTestedPackages(testUnitCommand, packages);
  problems.push(...describeSelectionProblems('pnpm test:unit', testUnit));

  const jobsByPackage = new Map<string, string[]>();
  for (const { job, command } of ciTestCommands) {
    const selection = selectTestedPackages(command, packages);
    problems.push(...describeSelectionProblems(`CI job ${job}`, selection));
    for (const name of selection.tested) {
      jobsByPackage.set(name, [...(jobsByPackage.get(name) ?? []), job]);
    }
  }

  for (const name of testUnit.tested) {
    if (!jobsByPackage.has(name)) {
      problems.push(`${name} is tested by pnpm test:unit but by no CI job`);
    }
  }
  for (const [name, jobs] of jobsByPackage) {
    if (!testUnit.tested.includes(name)) {
      problems.push(`${name} is tested in CI (${jobs.join(', ')}) but not by pnpm test:unit`);
    }
    if (jobs.length > 1) {
      problems.push(`${name} is tested by more than one CI job: ${jobs.join(', ')}`);
    }
  }

  return problems;
}

interface Selection {
  /** Packages whose `test` script the command runs, root excluded. */
  tested: string[];
  selectsRoot: boolean;
  /** Packages named by an inclusion filter that have no `test` script. */
  includedWithoutTestScript: string[];
}

/**
 * Works out which packages `pnpm [-r] [--filter <name> | --filter '!<name>']... test`
 * runs, following pnpm's rules: inclusion filters select the named packages;
 * exclusion-only filters select every workspace package, the root included;
 * `-r` without filters selects every package except the root. pnpm skips
 * selected packages that have no `test` script. Throws on any other syntax,
 * so an unfamiliar command fails the check rather than being misread.
 */
export function selectTestedPackages(command: string, packages: WorkspacePackage[]): Selection {
  const { recursive, included, excluded } = parseTestCommand(command);
  const unknown = [...included, ...excluded].find(
    (name) => !packages.some((pkg) => pkg.name === name),
  );
  if (unknown !== undefined) {
    throw new Error(`\`${command}\` filters on ${unknown}, which is not a workspace package`);
  }
  if (!recursive && included.length === 0) {
    throw new Error(
      `\`${command}\` has no --filter and no -r, so it runs only in the current directory`,
    );
  }

  const selected = selectPackages(packages, included, excluded).filter(
    (pkg) => !excluded.includes(pkg.name),
  );
  return {
    tested: selected.filter((pkg) => !pkg.isRoot && pkg.hasTestScript).map((pkg) => pkg.name),
    selectsRoot: selected.some((pkg) => pkg.isRoot),
    includedWithoutTestScript: selected
      .filter((pkg) => included.includes(pkg.name) && !pkg.hasTestScript)
      .map((pkg) => pkg.name),
  };
}

/** Whether a shell command runs the `test` script through pnpm. */
export function isPnpmTestCommand(command: string): boolean {
  const words = command.trim().split(/\s+/);
  return words[0] === 'pnpm' && words.at(-1) === 'test';
}

function describeSelectionProblems(source: string, selection: Selection): string[] {
  const problems: string[] = [];
  if (selection.selectsRoot) {
    problems.push(
      `${source} selects the workspace root, whose test script runs pnpm test:unit again; add --filter '!<root package name>'`,
    );
  }
  for (const name of selection.includedWithoutTestScript) {
    problems.push(`${source} filters on ${name}, which has no test script`);
  }
  return problems;
}

/** Packages selected before exclusion filters apply. */
function selectPackages(
  packages: WorkspacePackage[],
  included: string[],
  excluded: string[],
): WorkspacePackage[] {
  if (included.length > 0) return packages.filter((pkg) => included.includes(pkg.name));
  // Exclusion-only filters start from every package, the root included.
  if (excluded.length > 0) return packages;
  // A bare -r skips the root.
  return packages.filter((pkg) => !pkg.isRoot);
}

function parseTestCommand(command: string) {
  const words = command
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^(['"])(.*)\1$/, '$2'));
  const unsupported = new Error(
    `Cannot parse \`${command}\`: expected pnpm [-r] [--filter <name> | --filter '!<name>']... test`,
  );
  if (words[0] !== 'pnpm' || words.at(-1) !== 'test') throw unsupported;

  let recursive = false;
  const included: string[] = [];
  const excluded: string[] = [];
  const args = words
    .slice(1, -1)
    .flatMap((arg) =>
      arg.startsWith('--filter=') ? ['--filter', arg.slice('--filter='.length)] : [arg],
    );
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-r' || args[i] === '--recursive') {
      recursive = true;
      continue;
    }
    const filter = args[i] === '--filter' ? args[++i] : undefined;
    if (!isPackageNameFilter(filter)) throw unsupported;
    if (filter.startsWith('!')) excluded.push(filter.slice(1));
    else included.push(filter);
  }
  return { recursive, included, excluded };
}

// Package names only: path, glob and dependency selectors (`./dir`,
// `@scope/*`, `pkg...`) would need pnpm's own resolution to evaluate.
function isPackageNameFilter(filter: string | undefined): filter is string {
  return filter !== undefined && /^!?(@[\w-]+\/)?[\w-]+$/.test(filter);
}
