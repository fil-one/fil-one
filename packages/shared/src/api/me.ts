export interface MeResponse {
  orgId: string;
  orgName: string;
  orgConfirmed: boolean;
  suggestedOrgName?: string;
  email?: string;
  auroraTenantReady: boolean;
}

export interface ConfirmOrgRequest {
  orgName: string;
}

export interface ConfirmOrgResponse {
  orgId: string;
  orgName: string;
}
