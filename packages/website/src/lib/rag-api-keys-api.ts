import type {
  CreateRagApiKeyRequest,
  CreateRagApiKeyResponse,
  ListRagApiKeysResponse,
} from '@filone/shared';
import { apiRequest } from './api.js';

/**
 * Typed client functions for RAG API keys: bearer tokens scoped to the RAG
 * query endpoint, managed from the RAG Pipeline page. Distinct from S3 access
 * keys (lib/api.ts createAccessKey).
 */

export function listRagApiKeys(): Promise<ListRagApiKeysResponse> {
  return apiRequest<ListRagApiKeysResponse>('/rag-api-keys');
}

/**
 * Create a key. The response carries the plaintext `token` exactly once — it
 * can never be retrieved again, so the caller must show it to the user
 * immediately and let it fall out of state afterwards.
 */
export function createRagApiKey(body: CreateRagApiKeyRequest): Promise<CreateRagApiKeyResponse> {
  return apiRequest<CreateRagApiKeyResponse>('/rag-api-keys', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function deleteRagApiKey(keyId: string): Promise<void> {
  return apiRequest<void>(`/rag-api-keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
}
