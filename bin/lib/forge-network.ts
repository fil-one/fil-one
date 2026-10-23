// The Forge networks a stage provisions tenants on, and how a script reaches a
// network's Management API without hand-copied environment variables.
//
// Each network runs one Management API serving every region on it. FilOne puts
// one region on each network today; fil-one/fil-one#773 moves to one tenant
// per network, which turns `region` below into a list.
//
// The API URL is read from the deployed AccountDeletionWorker's environment
// (forgeEnv in sst.config.ts), so a script talks to the endpoint the stage
// actually runs. The state export is not used for the value itself because
// pulumi may store a function's environment as a secret. A variable of the same
// name in the operator's shell wins. Under SMELT=true the Lambda holds
// host.docker.internal URLs, which only floci's containers are sure to resolve;
// a script on the host then needs FORGE_DEV_MANAGEMENT_API_URL and
// FORGE_DEV_S3_ENDPOINT_URL pointing at localhost.
// The token comes from the stage's SST secret, or the app's fallback for it,
// and is held in memory only.

import { execFileSync } from 'node:child_process';
import {
  GetFunctionConfigurationCommand,
  type GetFunctionConfigurationCommandOutput,
} from '@aws-sdk/client-lambda';
import { S3Region } from '@filone/shared';
import { findResourceName, type StateResource } from './stage.ts';

export type ForgeNetworkName = 'staging' | 'dev';

export interface ForgeNetwork {
  region: S3Region;
  /** The Lambda env var holding the network's Management API URL. */
  apiUrlEnv: string;
  /** The SST secret holding the stage's Management API token. */
  tokenSecret: string;
  /** The Lambda env var that overrides the region's S3 endpoint (a local smelt network). */
  s3EndpointEnv?: string;
}

// Matches the Forge entries of getOrchestratorForRegion
// (packages/backend/src/lib/service-orchestrator-registry.ts).
export const FORGE_NETWORKS: Record<ForgeNetworkName, ForgeNetwork> = {
  staging: {
    region: S3Region.EuCentral3,
    apiUrlEnv: 'FORGE_MANAGEMENT_API_URL',
    tokenSecret: 'ForgeManagementApiToken',
  },
  dev: {
    region: S3Region.UsEast9,
    apiUrlEnv: 'FORGE_DEV_MANAGEMENT_API_URL',
    tokenSecret: 'ForgeDevManagementApiToken',
    s3EndpointEnv: 'FORGE_DEV_S3_ENDPOINT_URL',
  },
};

export interface ForgeApi {
  baseUrl: string;
  token: string;
  /** Set only when the stage overrides the region's public S3 endpoint. */
  s3EndpointUrl?: string;
}

/**
 * The subset of LambdaClient the lookups use, so tests can pass a stub.
 */
export interface LambdaConfigReader {
  send(command: GetFunctionConfigurationCommand): Promise<GetFunctionConfigurationCommandOutput>;
}

// The worker carries orchestratorEnv and is the component that deletes
// tenants, so every stage that can provision a Forge tenant deploys it.
const FORGE_ENV_FUNCTION = '::AccountDeletionWorkerFunction';

export function isForgeNetworkName(name: string): name is ForgeNetworkName {
  return Object.hasOwn(FORGE_NETWORKS, name);
}

export function getNetworkForRegion(region: string): ForgeNetworkName | undefined {
  return (Object.keys(FORGE_NETWORKS) as ForgeNetworkName[]).find(
    (name) => FORGE_NETWORKS[name].region === region,
  );
}

/**
 * The Management API URL, token and S3 endpoint override a stage uses for one
 * Forge network. Exits with a message naming the missing piece.
 */
export async function resolveForgeApi(
  stage: string,
  network: ForgeNetwork,
  resources: StateResource[],
  lambda: LambdaConfigReader,
): Promise<ForgeApi> {
  const functionName = findResourceName(
    resources,
    'aws:lambda/function:Function',
    FORGE_ENV_FUNCTION,
  );
  if (!functionName) {
    console.error(
      `No AccountDeletionWorker function in the exported state for stage "${stage}". ` +
        'Is the stage deployed?',
    );
    process.exit(1);
  }

  const names = [network.apiUrlEnv, ...(network.s3EndpointEnv ? [network.s3EndpointEnv] : [])];
  const env = applyShellOverrides(await readLambdaEnv(lambda, functionName, names), process.env);
  const baseUrl = env[network.apiUrlEnv];
  if (!baseUrl) {
    console.error(
      `${functionName} has no ${network.apiUrlEnv}. The stage does not use this Forge network ` +
        '(production) or was deployed before it existed.',
    );
    process.exit(1);
  }

  return {
    baseUrl,
    token: readStageSecret(stage, network.tokenSecret),
    ...(network.s3EndpointEnv &&
      env[network.s3EndpointEnv] && { s3EndpointUrl: env[network.s3EndpointEnv] }),
  };
}

/**
 * The named variables from a deployed function's environment, and nothing
 * else: other keys in the environment may be credentials.
 */
export async function readLambdaEnv(
  lambda: LambdaConfigReader,
  functionName: string,
  names: string[],
): Promise<Record<string, string | undefined>> {
  const { Environment } = await lambda.send(
    new GetFunctionConfigurationCommand({ FunctionName: functionName }),
  );
  const variables = Environment?.Variables ?? {};
  return Object.fromEntries(names.map((name) => [name, variables[name]]));
}

/**
 * The deployed values, each replaced by a non-empty variable of the same name
 * from `shellEnv`.
 */
export function applyShellOverrides(
  deployed: Record<string, string | undefined>,
  shellEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(deployed).map(([name, value]) => [name, shellEnv[name] || value]),
  );
}

/**
 * One secret's value for a stage, from `sst secret list`: the stage's own, or
 * the app's fallback when the stage has none, as the deployed stage resolves it.
 *
 * The command prints every secret on the stage, so neither its output nor the
 * error carrying it is ever printed.
 */
export function readStageSecret(stage: string, name: string): string {
  let output: string;
  try {
    output = execFileSync('pnpm', ['exec', 'sst', 'secret', 'list', '--stage', stage], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch {
    console.error(`\`pnpm exec sst secret list --stage ${stage}\` failed; see its error above.`);
    process.exit(1);
  }

  const value = parseSecretList(output, stage, name);
  if (!value) {
    console.error(
      `Stage "${stage}" has no ${name} secret and there is no fallback. Set it with\n` +
        `  pnpm exec sst secret set ${name} --stage ${stage}`,
    );
    process.exit(1);
  }
  return value;
}

/**
 * The value of `name` in `sst secret list` output, which prints the app's
 * fallback secrets under `# fallback` and the stage's own under
 * `# filone/<stage>`, each followed by `Name=value` lines. The stage's value
 * wins over the fallback; lines under any other header are ignored.
 */
export function parseSecretList(output: string, stage: string, name: string): string | undefined {
  const stageHeader = `# filone/${stage}`;
  const values: { stage?: string; fallback?: string } = {};
  let section: 'stage' | 'fallback' | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('#')) {
      const header = line.trim();
      section = header === stageHeader ? 'stage' : header === '# fallback' ? 'fallback' : undefined;
      continue;
    }
    const separator = line.indexOf('=');
    if (section && separator !== -1 && line.slice(0, separator) === name) {
      values[section] = line.slice(separator + 1).trimEnd();
    }
  }
  return values.stage ?? values.fallback;
}
