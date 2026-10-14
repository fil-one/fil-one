import { describe, expect, it } from 'vitest';

import {
  findTestCoverageProblems,
  isPnpmTestCommand,
  type TestCoverageInput,
  type WorkspacePackage,
} from './ci-unit-tests.ts';

function pkg(name: string, overrides: Partial<WorkspacePackage> = {}): WorkspacePackage {
  return { name, isRoot: false, hasTestScript: true, ...overrides };
}

// A root package and two packages with tests, one of them in a dedicated job
// and the other picked up by a catch-all job.
const packages = [pkg('any-root', { isRoot: true }), pkg('@any/alpha'), pkg('@any/beta')];

function input(overrides: Partial<TestCoverageInput> = {}): TestCoverageInput {
  return {
    packages,
    testUnitCommand: "pnpm -r --filter '!any-root' test",
    ciTestCommands: [
      { job: 'job-alpha', command: 'pnpm --filter @any/alpha test' },
      { job: 'job-rest', command: "pnpm -r --filter '!any-root' --filter '!@any/alpha' test" },
    ],
    ...overrides,
  };
}

describe('findTestCoverageProblems', () => {
  it('reports no problems when CI tests the same packages as pnpm test:unit', () => {
    expect(findTestCoverageProblems(input())).toStrictEqual([]);
  });

  it('reports no problems when pnpm test:unit uses a bare -r, which skips the root', () => {
    expect(findTestCoverageProblems(input({ testUnitCommand: 'pnpm -r test' }))).toStrictEqual([]);
  });

  it('ignores packages without a test script that a catch-all command selects', () => {
    const withUntested = [...packages, pkg('@any/no-tests', { hasTestScript: false })];
    expect(findTestCoverageProblems(input({ packages: withUntested }))).toStrictEqual([]);
  });

  it.each([
    {
      problem: 'a package missing from CI',
      ciTestCommands: [{ job: 'job-alpha', command: 'pnpm --filter @any/alpha test' }],
      expected: ['@any/beta is tested by pnpm test:unit but by no CI job'],
    },
    {
      problem: 'a package excluded from the catch-all job without a job of its own',
      ciTestCommands: [
        {
          job: 'job-rest',
          command: "pnpm -r --filter '!any-root' --filter '!@any/alpha' test",
        },
      ],
      expected: ['@any/alpha is tested by pnpm test:unit but by no CI job'],
    },
    {
      problem: 'a package tested by two CI jobs',
      ciTestCommands: [
        { job: 'job-alpha', command: 'pnpm --filter @any/alpha test' },
        { job: 'job-rest', command: "pnpm -r --filter '!any-root' test" },
      ],
      expected: ['@any/alpha is tested by more than one CI job: job-alpha, job-rest'],
    },
  ])('reports $problem', ({ ciTestCommands, expected }) => {
    expect(findTestCoverageProblems(input({ ciTestCommands }))).toStrictEqual(expected);
  });

  it('reports a package that CI tests but pnpm test:unit does not', () => {
    const testUnitCommand = "pnpm -r --filter '!any-root' --filter '!@any/beta' test";
    expect(findTestCoverageProblems(input({ testUnitCommand }))).toStrictEqual([
      '@any/beta is tested in CI (job-rest) but not by pnpm test:unit',
    ]);
  });

  // Exclusion-only filters select the root too, unlike a bare `-r`.
  it.each([
    {
      source: 'pnpm test:unit',
      overrides: { testUnitCommand: "pnpm -r --filter '!@any/never' test" },
    },
    {
      source: 'CI job job-rest',
      overrides: {
        ciTestCommands: [
          { job: 'job-alpha', command: 'pnpm --filter @any/alpha test' },
          { job: 'job-rest', command: "pnpm -r --filter '!@any/alpha' test" },
        ],
      },
    },
  ])('reports $source selecting the workspace root', ({ source, overrides }) => {
    const withNever = [...packages, pkg('@any/never', { hasTestScript: false })];
    expect(findTestCoverageProblems(input({ packages: withNever, ...overrides }))).toStrictEqual([
      `${source} selects the workspace root, whose test script runs pnpm test:unit again; add --filter '!<root package name>'`,
    ]);
  });

  it('reports a CI job that filters on a package without a test script', () => {
    const withUntested = [...packages, pkg('@any/no-tests', { hasTestScript: false })];
    const ciTestCommands = [
      ...input().ciTestCommands,
      { job: 'job-none', command: 'pnpm --filter @any/no-tests test' },
    ];
    expect(
      findTestCoverageProblems(input({ packages: withUntested, ciTestCommands })),
    ).toStrictEqual(['CI job job-none filters on @any/no-tests, which has no test script']);
  });

  // Path, glob and dependency selectors need pnpm's own resolution to evaluate.
  it.each([
    'pnpm --filter ./packages/alpha test',
    "pnpm --filter '@any/*' test",
    'pnpm --filter @any/alpha... test',
    'pnpm --recursive --workspace-root test',
  ])('throws on the unsupported command %s', (command) => {
    const ciTestCommands = [{ job: 'job-any', command }];
    expect(() => findTestCoverageProblems(input({ ciTestCommands }))).toThrow(
      `Cannot parse \`${command}\`: expected pnpm [-r] [--filter <name> | --filter '!<name>']... test`,
    );
  });

  it('throws on a command that runs only in the current directory', () => {
    const ciTestCommands = [{ job: 'job-any', command: 'pnpm test' }];
    expect(() => findTestCoverageProblems(input({ ciTestCommands }))).toThrow(
      '`pnpm test` has no --filter and no -r, so it runs only in the current directory',
    );
  });

  it('throws when a filter names a package outside the workspace', () => {
    const ciTestCommands = [{ job: 'job-any', command: 'pnpm --filter @any/unknown test' }];
    expect(() => findTestCoverageProblems(input({ ciTestCommands }))).toThrow(
      '`pnpm --filter @any/unknown test` filters on @any/unknown, which is not a workspace package',
    );
  });
});

describe('isPnpmTestCommand', () => {
  it.each([
    { command: 'pnpm --filter @any/alpha test', expected: true },
    { command: '  pnpm -r test  ', expected: true },
    { command: 'pnpm test:storybook', expected: false },
    { command: 'pnpm install --frozen-lockfile', expected: false },
    { command: 'npx vitest test', expected: false },
  ])('returns $expected for `$command`', ({ command, expected }) => {
    expect(isPnpmTestCommand(command)).toBe(expected);
  });
});
