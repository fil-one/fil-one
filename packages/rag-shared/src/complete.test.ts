import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { Uint8ArrayBlobAdapter } from '@smithy/util-stream';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  BEDROCK_ANTHROPIC_VERSION,
  COMPLETION_MAX_TOKENS,
  COMPLETION_MODEL_ID,
} from './constants.js';
import { complete } from './complete.js';

const bedrockMock = mockClient(BedrockRuntimeClient);

function client(): BedrockRuntimeClient {
  return bedrockMock as unknown as BedrockRuntimeClient;
}

function encodeBody(value: unknown): Uint8ArrayBlobAdapter {
  return Uint8ArrayBlobAdapter.fromString(JSON.stringify(value));
}

function textResponse(text: string): Uint8ArrayBlobAdapter {
  return encodeBody({ content: [{ type: 'text', text }] });
}

describe('complete', () => {
  beforeEach(() => {
    bedrockMock.reset();
  });

  it('invokes the default model with the Bedrock Anthropic body shape', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({ body: textResponse('hi') });

    await complete('hello', undefined, client());

    const calls = bedrockMock.commandCalls(InvokeModelCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0]!.input;
    expect(input.modelId).toBe(COMPLETION_MODEL_ID);
    expect(input.contentType).toBe('application/json');
    expect(input.body).toBeInstanceOf(Uint8Array);

    const sent = JSON.parse(new TextDecoder().decode(input.body as Uint8Array)) as Record<
      string,
      unknown
    >;
    expect(sent).toEqual({
      anthropic_version: BEDROCK_ANTHROPIC_VERSION,
      max_tokens: COMPLETION_MAX_TOKENS,
      messages: [{ role: 'user', content: 'hello' }],
    });
    // No system prompt provided -> the field is omitted from the request body.
    expect(sent.system).toBeUndefined();
    expect('system' in sent).toBe(false);
  });

  it('forwards the system prompt into the Bedrock request body when provided', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({ body: textResponse('hi') });

    await complete('hello', { system: 'answer only from context' }, client());

    const input = bedrockMock.commandCalls(InvokeModelCommand)[0]!.args[0]!.input;
    const sent = JSON.parse(new TextDecoder().decode(input.body as Uint8Array)) as Record<
      string,
      unknown
    >;
    expect(sent.system).toBe('answer only from context');
  });

  it('does not send sampling parameters', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({ body: textResponse('hi') });

    await complete('hello', undefined, client());

    const input = bedrockMock.commandCalls(InvokeModelCommand)[0]!.args[0]!.input;
    const sent = JSON.parse(new TextDecoder().decode(input.body as Uint8Array)) as Record<
      string,
      unknown
    >;
    expect(sent.temperature).toBeUndefined();
    expect(sent.top_p).toBeUndefined();
    expect(sent.top_k).toBeUndefined();
  });

  it('honors a model override, a system prompt, and a max-tokens override', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({ body: textResponse('hi') });

    await complete(
      'hello',
      { modelId: 'us.anthropic.custom-model', system: 'be terse', maxTokens: 42 },
      client(),
    );

    const input = bedrockMock.commandCalls(InvokeModelCommand)[0]!.args[0]!.input;
    expect(input.modelId).toBe('us.anthropic.custom-model');
    const sent = JSON.parse(new TextDecoder().decode(input.body as Uint8Array)) as Record<
      string,
      unknown
    >;
    expect(sent.system).toBe('be terse');
    expect(sent.max_tokens).toBe(42);
  });

  it('concatenates multiple text blocks and ignores non-text blocks', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({
      body: encodeBody({
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'thinking', thinking: 'ignored' },
          { type: 'text', text: 'part two' },
        ],
      }),
    });

    const result = await complete('hello', undefined, client());
    expect(result).toBe('part one part two');
  });

  it('throws on empty prompt without calling Bedrock', async () => {
    await expect(complete('', undefined, client())).rejects.toThrow(/cannot be empty/);
    await expect(complete('   ', undefined, client())).rejects.toThrow(/cannot be empty/);
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0);
  });

  it('throws on an empty response body', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({});
    await expect(complete('hello', undefined, client())).rejects.toThrow(/empty response body/);
  });

  it('throws when the response has no text content', async () => {
    bedrockMock.on(InvokeModelCommand).resolves({ body: encodeBody({ content: [] }) });
    await expect(complete('hello', undefined, client())).rejects.toThrow(/no text content/);
  });

  it('propagates a Bedrock failure', async () => {
    bedrockMock.on(InvokeModelCommand).rejects(new Error('AccessDeniedException'));
    await expect(complete('hello', undefined, client())).rejects.toThrow('AccessDeniedException');
  });
});
