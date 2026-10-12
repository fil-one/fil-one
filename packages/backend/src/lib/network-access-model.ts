import { parseAccessModel, type NetworkAccessModels } from '@filone/shared';

/**
 * The access model each Forge network serves, from the deploy config that
 * sst.config.ts reads out of the console's env file, so the console and the
 * backend never disagree. Read per call so tests can set it.
 */
export function getNetworkAccessModels(): NetworkAccessModels {
  return {
    forge: parseAccessModel(process.env.FORGE_ACCESS_MODEL),
    forgeDev: parseAccessModel(process.env.FORGE_DEV_ACCESS_MODEL),
  };
}
