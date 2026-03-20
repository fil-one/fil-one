export interface MeResponse {
  orgId: string;
  orgName: string;
  orgConfirmed: boolean;
  emailVerified: boolean;
  suggestedOrgName?: string;
  email?: string;
  orgSetupComplete: boolean;
}

export interface ConfirmOrgRequest {
  orgName: string;
}

export interface ConfirmOrgResponse {
  orgId: string;
  orgName: string;
}
