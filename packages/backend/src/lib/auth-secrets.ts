import { Resource } from 'sst';

export interface AuthSecrets {
  AUTH0_CLIENT_ID: string;
  AUTH0_CLIENT_SECRET: string;
}

export function getAuthSecrets(): AuthSecrets {
  return {
    AUTH0_CLIENT_ID: Resource.Auth0ClientId.value,
    AUTH0_CLIENT_SECRET: Resource.Auth0ClientSecret.value,
  };
}

export interface AuroraBackofficeSecrets {
  AURORA_BACKOFFICE_TOKEN: string;
}

export function getAuroraBackofficeSecrets(): AuroraBackofficeSecrets {
  return {
    AURORA_BACKOFFICE_TOKEN: Resource.AuroraBackofficeToken.value,
  };
}
