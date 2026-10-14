#!/usr/bin/env node

// Fails when the CI workflow does not unit-test exactly the packages that
// `pnpm test:unit` tests: a package missing from CI, tested twice, or tested
// in CI only. See bin/lib/ci-unit-tests.ts for the rules.
//
// Usage:
//   node bin/check-ci-unit-tests.ts
//
// lint-staged runs it when a package.json, pnpm-workspace.yaml or the
// workflow is staged, and passes the staged paths as arguments. The check
// always covers the whole repository, so it ignores them.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

import {
  findTestCoverageProblems,
  isPnpmTestCommand,
  type CiTestCommand,
  type WorkspacePackage,
} from './lib/ci-unit-tests.ts';

const repoRoot = join(import.meta.dirname, '..');
const workflowPath = '.github/workflows/packages-ci.yaml';

const problems = findTestCoverageProblems({
  packages: readWorkspacePackages(),
  testUnitCommand: readTestUnitCommand(),
  ciTestCommands: readCiTestCommands(),
});

if (problems.length > 0) {
  console.error(`${workflowPath} and pnpm test:unit test different packages:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
}

function readWorkspacePackages(): WorkspacePackage[] {
  const output = execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  // The shape pnpm prints for `ls --json`; nothing checks it at compile time.
  const listed = JSON.parse(output) as { name: string; path: string }[];
  return listed.map(({ name, path }) => ({
    name,
    isRoot: path === repoRoot,
    hasTestScript: readPackageJson(path).scripts?.test !== undefined,
  }));
}

function readTestUnitCommand(): string {
  const command = readPackageJson(repoRoot).scripts?.['test:unit'];
  if (command === undefined) throw new Error('The root package.json has no test:unit script');
  return command;
}

function readCiTestCommands(): CiTestCommand[] {
  // The part of the GitHub Actions workflow schema this check reads.
  const workflow = parse(readFileSync(join(repoRoot, workflowPath), 'utf8')) as {
    jobs: Record<string, { steps?: { run?: string }[] }>;
  };
  return Object.entries(workflow.jobs).flatMap(([job, { steps = [] }]) =>
    steps
      .flatMap((step) => step.run?.split('\n') ?? [])
      .filter(isPnpmTestCommand)
      .map((command) => ({ job, command: command.trim() })),
  );
}

function readPackageJson(dir: string): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}
