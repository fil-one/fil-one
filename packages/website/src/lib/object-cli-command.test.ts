import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { getObjectCliCommand, quoteShellArg } from './object-cli-command.js';

const endpoint = 'https://any-endpoint.example';

/** What a POSIX shell makes of `word`: the argument it passes on. */
function readAsShell(word: string): string {
  return execFileSync('/bin/sh', ['-c', `printf %s ${word}`], { encoding: 'utf8' });
}

describe('quoteShellArg', () => {
  it.each([
    ['command substitution', 'x$(touch any-file).csv'],
    ['backticks', 'x`touch any-file`.csv'],
    ['a variable', 'x$HOME.csv'],
    ['a single quote', "it's.csv"],
    ['spaces and a glob', 'any file *.csv'],
  ])('passes a key with %s to the shell as literal text', (_case, key) => {
    expect(readAsShell(quoteShellArg(key))).toBe(key);
  });
});

describe('getObjectCliCommand', () => {
  it('copies the latest version with s3 cp under the filone profile', () => {
    expect(
      getObjectCliCommand({ bucketName: 'any-bucket', objectKey: 'any/key.csv', endpoint }),
    ).toBe(
      `aws s3 cp 's3://any-bucket/any/key.csv' ./ --endpoint-url ${endpoint} --profile filone`,
    );
  });

  it('downloads a named version with s3api get-object into the file name', () => {
    expect(
      getObjectCliCommand({
        bucketName: 'any-bucket',
        objectKey: 'any/key.csv',
        versionId: 'any-version',
        endpoint,
      }),
    ).toBe(
      `aws s3api get-object --bucket 'any-bucket' --key 'any/key.csv' --version-id 'any-version' './key.csv' --endpoint-url ${endpoint} --profile filone`,
    );
  });

  it('quotes the key in the version command too', () => {
    // The key would run a command if left unquoted or in double quotes
    const command = getObjectCliCommand({
      bucketName: 'any-bucket',
      objectKey: 'x$(touch any-file).csv',
      versionId: 'any-version',
      endpoint,
    });
    expect(command).toContain(`--key 'x$(touch any-file).csv'`);
  });
});
