import { CLI_PROFILE } from './connection-snippets.js';
import { getObjectFileName } from './object-preview.js';

/**
 * A value as one literal shell word. Inside single quotes the shell expands
 * nothing, so `$(...)`, backticks and `$VAR` in an object key stay text. A
 * single quote cannot appear inside them, so each one closes the quotes, adds an
 * escaped quote and reopens them.
 */
export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The AWS CLI command that downloads the object on screen. The latest version
 * uses `s3 cp`. A named version needs `s3api get-object`, as `s3 cp` cannot
 * take a version ID. Both use the profile the console's CLI set-up configures,
 * which holds the keys and path-style addressing.
 */
export function getObjectCliCommand({
  bucketName,
  objectKey,
  versionId,
  endpoint,
}: {
  bucketName: string;
  objectKey: string;
  versionId?: string;
  endpoint: string;
}): string {
  const options = `--endpoint-url ${endpoint} --profile ${CLI_PROFILE}`;
  if (!versionId) {
    // `./` keeps the file's own name
    return `aws s3 cp ${quoteShellArg(`s3://${bucketName}/${objectKey}`)} ./ ${options}`;
  }
  // `./` also stops a file name that starts with `-` reading as an option
  const outfile = quoteShellArg(`./${getObjectFileName(objectKey)}`);
  return `aws s3api get-object --bucket ${quoteShellArg(bucketName)} --key ${quoteShellArg(objectKey)} --version-id ${quoteShellArg(versionId)} ${outfile} ${options}`;
}
