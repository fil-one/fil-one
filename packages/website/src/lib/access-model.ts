import { parseAccessModel, type NetworkAccessModels } from '@filone/shared';

/**
 * The access model each Forge network serves, from the console's build env.
 * sst.config.ts hands the backend the same values from the same file. Read per
 * call so tests can stub the env.
 */
export function getNetworkAccessModels(): NetworkAccessModels {
  return {
    forge: parseAccessModel(import.meta.env.VITE_FORGE_ACCESS_MODEL),
    forgeDev: parseAccessModel(import.meta.env.VITE_FORGE_DEV_ACCESS_MODEL),
  };
}
