import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

import {
  BEDROCK_ANTHROPIC_VERSION,
  COMPLETION_MAX_TOKENS,
  COMPLETION_MODEL_ID,
} from './constants.js';

/**
 * Options accepted by {@link complete}.
 */
export interface CompleteOptions {
  /** Bedrock model id to invoke. Defaults to {@link COMPLETION_MODEL_ID}. */
  modelId?: string;
  /** Max tokens the model may generate. Defaults to {@link COMPLETION_MAX_TOKENS}. */
  maxTokens?: number;
  /** Optional system prompt establishing how the model should answer. */
  system?: string;
}

/**
 * The subset of the Bedrock Anthropic Messages response body we read.
 */
interface AnthropicMessageResponse {
  content?: { type?: string; text?: unknown }[];
}

/**
 * Generate a single-turn completion from a Claude model on Amazon Bedrock.
 *
 * Uses the Bedrock Anthropic Messages format (`anthropic_version`, `system`,
 * `messages`, `max_tokens`). Sampling parameters are intentionally omitted —
 * current Claude models reject `temperature`/`top_p`/`top_k`. Callers'
 * execution roles need `bedrock:InvokeModel` on the model.
 *
 * @throws if `prompt` is empty/whitespace, if Bedrock fails, or if the response
 *   contains no text content.
 */
export async function complete(
  prompt: string,
  options?: CompleteOptions,
  client?: BedrockRuntimeClient,
): Promise<string> {
  if (!prompt || prompt.trim().length === 0) {
    throw new Error('Prompt to complete cannot be empty');
  }

  const bedrock = client ?? new BedrockRuntimeClient({});
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: options?.modelId ?? COMPLETION_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(
        JSON.stringify({
          anthropic_version: BEDROCK_ANTHROPIC_VERSION,
          max_tokens: options?.maxTokens ?? COMPLETION_MAX_TOKENS,
          ...(options?.system ? { system: options.system } : {}),
          messages: [{ role: 'user', content: prompt }],
        }),
      ),
    }),
  );

  if (!response.body) {
    throw new Error('Bedrock returned an empty response body');
  }

  const parsed = JSON.parse(new TextDecoder().decode(response.body)) as AnthropicMessageResponse;

  const text = (parsed.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');

  if (text.length === 0) {
    throw new Error('Bedrock completion returned no text content');
  }

  return text;
}
