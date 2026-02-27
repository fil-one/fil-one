import { Resource } from "sst";

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
