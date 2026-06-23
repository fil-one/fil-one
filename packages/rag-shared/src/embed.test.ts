import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { Uint8ArrayBlobAdapter } from '@smithy/util-stream';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { EMBEDDING_DIMENSION, EMBEDDING_MODEL_ID } from './constants.js';
import { embed, embedMany } from './embed.js';

const bedrockMock = mockClient(BedrockRuntimeClient);

function client(): BedrockRuntimeClient {
  return bedrockMock as unknown as BedrockRuntimeClient;
}

function encodeBody(value: unknown): Uint8ArrayBlobAdapter {
  return Uint8ArrayBlobAdapter.fromString(JSON.stringify(value));
}

function validVector(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => i / EMBEDDING_DIMENSION);
}

describe('embed', () => {
  beforeEach(() => {
    bedrockMock.reset();
  });

  it('invokes Titan with the correct model id and request body shape', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: encodeBody({ embedding: validVector() }),
      contentType: 'application/json',
    });

    await embed('hello world', client());

    const calls = bedrockMock.commandCalls(InvokeModelCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0]!.input;
    expect(input.modelId).toBe(EMBEDDING_MODEL_ID);
    expect(input.modelId).toBe('amazon.titan-embed-text-v2:0');
    expect(input.contentType).toBe('application/json');

    // embed() always encodes the request body to a Uint8Array.
    expect(input.body).toBeInstanceOf(Uint8Array);
    const body = JSON.parse(new TextDecoder().decode(input.body as Uint8Array)) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      inputText: 'hello world',
      dimensions: 1024,
      normalize: true,
    });
  });

  it('parses and returns the embedding as a number[] of length 1024', async () => {
    const vector = validVector();
    bedrockMock.on(InvokeModelCommand).resolves({
      body: encodeBody({ embedding: vector }),
      contentType: 'application/json',
    });

    const result = await embed('text', client());
    expect(result).toEqual(vector);
    expect(result).toHaveLength(EMBEDDING_DIMENSION);
  });

  it('throws on empty text without calling Bedrock', async () => {
    await expect(embed('', client())).rejects.toThrow(/cannot be empty/);
    await expect(embed('   ', client())).rejects.toThrow(/cannot be empty/);
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0);
  });

  it('throws on a dimension mismatch', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: encodeBody({ embedding: [0.1, 0.2, 0.3] }),
      contentType: 'application/json',
    });
    await expect(embed('text', client())).rejects.toThrow(/dimension mismatch/);
  });

  it('throws when the response has no embedding field', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: encodeBody({ notEmbedding: true }),
      contentType: 'application/json',
    });
    await expect(embed('text', client())).rejects.toThrow(/dimension mismatch/);
  });

  it('throws on an empty response body', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({ contentType: 'application/json' });
    await expect(embed('text', client())).rejects.toThrow(/empty response body/);
  });

  it('propagates a Bedrock failure', async () => {
    bedrockMock.on(InvokeModelCommand).rejects(new Error('AccessDeniedException'));
    await expect(embed('text', client())).rejects.toThrow('AccessDeniedException');
  });
});

describe('embedMany', () => {
  beforeEach(() => {
    bedrockMock.reset();
  });

  it('calls embed once per text and preserves order', async () => {
    const a = validVector();
    const b = validVector().map((n) => n + 1);
    bedrockMock
      .on(InvokeModelCommand)
      .resolvesOnce({ body: encodeBody({ embedding: a }), contentType: 'application/json' })
      .resolvesOnce({ body: encodeBody({ embedding: b }), contentType: 'application/json' });

    const results = await embedMany(['first', 'second'], client());
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(2);
    expect(results).toEqual([a, b]);
  });
});
