import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ResponseBuilder } from './response-builder.ts';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcError = { code: number; message: string };
export type JsonRpcOutcome = { result: unknown } | { error: JsonRpcError };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    isRecord(value) &&
    value.jsonrpc === '2.0' &&
    typeof value.method === 'string' &&
    (value.params === undefined || isRecord(value.params))
  );
}

export function buildJsonRpcResponse(
  id: JsonRpcRequest['id'] | null,
  outcome: JsonRpcOutcome,
): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(200)
    .body({ jsonrpc: '2.0', id, ...outcome })
    .build();
}
