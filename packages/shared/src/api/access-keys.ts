export type AccessKeyStatus = 'active' | 'inactive';

export interface AccessKey {
  id: string;
  name: string;
  accessKeyId: string;
  createdAt: string;
  lastUsedAt?: string;
  status: AccessKeyStatus;
}

export interface ListAccessKeysResponse {
  keys: AccessKey[];
}

export interface CreateAccessKeyRequest {
  name: string;
}

export interface CreateAccessKeyResponse {
  key: AccessKey;
  secretAccessKey: string;
}

export interface DeleteAccessKeyRequest {
  keyId: string;
}

export interface UpdateAccessKeyRequest {
  keyId: string;
  status: AccessKeyStatus;
}

export interface UpdateAccessKeyResponse {
  key: AccessKey;
}
