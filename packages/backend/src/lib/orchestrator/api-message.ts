// The contract's error body is `{ message, code? }`, returned in the SDK
// result's `error` field. Both readers are here so every orchestrator method
// spells the extraction the same way.

export function extractApiMessage(body: unknown): string | undefined {
  return readStringField(body, 'message');
}

export function extractApiCode(body: unknown): string | undefined {
  return readStringField(body, 'code');
}

function readStringField(body: unknown, field: string): string | undefined {
  if (body && typeof body === 'object' && field in body) {
    const value = (body as Record<string, unknown>)[field];
    if (typeof value === 'string') return value;
  }
  return undefined;
}
