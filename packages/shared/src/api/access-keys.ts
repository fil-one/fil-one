export type AccessKeyStatus = 'active' | 'inactive';

export interface AccessKey {
  id: string;
  keyName: string;
  accessKeyId: string;
  createdAt: string;
  lastUsedAt?: string;
  status: AccessKeyStatus;
}

export interface ListAccessKeysResponse {
  keys: AccessKey[];
}

export interface CreateAccessKeyRequest {
  keyName: string;
}

export interface CreateAccessKeyResponse {
  id: string;
  keyName: string;
  accessKeyId: string;
  secretAccessKey: string;
  createdAt: string;
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
