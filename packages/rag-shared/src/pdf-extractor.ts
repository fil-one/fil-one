import { setTimeout as delay } from 'node:timers/promises';

import {
  type Block,
  GetDocumentTextDetectionCommand,
  type GetDocumentTextDetectionCommandOutput,
  type S3Object,
  StartDocumentTextDetectionCommand,
  TextractClient,
} from '@aws-sdk/client-textract';

/**
 * Default delay, in milliseconds, between consecutive `GetDocumentTextDetection`
 * polls. Chosen to avoid hammering the API while keeping latency reasonable.
 */
const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Default maximum number of polls before giving up. With the default 1s
 * interval this bounds the wait at roughly five minutes.
 */
const DEFAULT_MAX_POLLS = 300;

/**
 * Stages the PDF bytes somewhere Textract can read them (an S3 object) and
 * returns the resulting {@link S3Object} reference. The asynchronous Textract
 * API only accepts documents by S3 location, never inline bytes, so callers
 * provide this so the rag-shared package need not depend on the S3 client.
 */
export type StageDocument = (bytes: Uint8Array) => Promise<S3Object>;

/**
 * Options common to every {@link extractTextFromPdf} call, regardless of how the
 * document is supplied to Textract.
 */
interface PdfExtractionOptionsBase {
  /** Textract client to use. Defaults to a new {@link TextractClient}. */
  client?: TextractClient;
  /** Delay between polls in ms. Defaults to {@link DEFAULT_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Maximum number of polls. Defaults to {@link DEFAULT_MAX_POLLS}. */
  maxPolls?: number;
  /**
   * Async delay used between polls. Defaults to `node:timers/promises`
   * `setTimeout`; injectable so tests can observe the wait without sleeping for
   * real.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Options controlling {@link extractTextFromPdf}.
 *
 * The asynchronous Textract API only reads documents from S3, so exactly one
 * way of reaching the bytes must be supplied: either an explicit
 * `documentLocation` pointing at an already-staged S3 object, or a
 * `stageDocument` callback that uploads the bytes and returns their location.
 * The union makes this a compile-time requirement — passing neither (or both)
 * is a type error.
 */
export type PdfExtractionOptions = PdfExtractionOptionsBase &
  (
    | {
        /** S3 location of an already-staged document to analyse. */
        documentLocation: S3Object;
        stageDocument?: never;
      }
    | {
        /** Stages the bytes to S3 and returns their location. */
        stageDocument: StageDocument;
        documentLocation?: never;
      }
  );

/**
 * Resolve the S3 location of the document, staging the raw bytes if no explicit
 * location was provided.
 */
async function resolveLocation(
  bytes: Uint8Array,
  options: PdfExtractionOptions,
): Promise<S3Object> {
  if (options.documentLocation) {
    return options.documentLocation;
  }
  if (options.stageDocument) {
    return options.stageDocument(bytes);
  }
  throw new Error(
    'extractTextFromPdf requires either documentLocation or stageDocument to reach Textract',
  );
}

/**
 * Poll `GetDocumentTextDetection` until the job leaves IN_PROGRESS, sleeping
 * between polls (never busy-looping). Returns the terminal first-page response.
 *
 * @throws if the job fails or the poll budget is exhausted.
 */
async function pollUntilDone(
  client: TextractClient,
  jobId: string,
  pollIntervalMs: number,
  maxPolls: number,
  sleep: (ms: number) => Promise<void>,
): Promise<GetDocumentTextDetectionCommandOutput> {
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const response = await client.send(new GetDocumentTextDetectionCommand({ JobId: jobId }));
    const status = response.JobStatus;
    if (status === 'SUCCEEDED' || status === 'PARTIAL_SUCCESS') {
      return response;
    }
    if (status === 'FAILED') {
      throw new Error(`Textract job ${jobId} failed: ${response.StatusMessage ?? 'unknown error'}`);
    }
    // status is IN_PROGRESS (or undefined): wait, then poll again.
    await sleep(pollIntervalMs);
  }
  throw new Error(`Textract job ${jobId} did not complete within ${maxPolls} polls`);
}

/**
 * Follow `NextToken` to gather every page of blocks for a completed job,
 * starting from the terminal response already fetched while polling.
 */
async function collectBlocks(
  client: TextractClient,
  jobId: string,
  first: GetDocumentTextDetectionCommandOutput,
): Promise<Block[]> {
  const blocks: Block[] = [...(first.Blocks ?? [])];
  let nextToken = first.NextToken;
  while (nextToken) {
    const page = await client.send(
      new GetDocumentTextDetectionCommand({ JobId: jobId, NextToken: nextToken }),
    );
    blocks.push(...(page.Blocks ?? []));
    nextToken = page.NextToken;
  }
  return blocks;
}

/**
 * Order LINE blocks in natural reading order: by page, then top-to-bottom
 * (vertical geometry), then left-to-right (horizontal geometry). Textract
 * already emits blocks in reading order per page, but sorting by geometry makes
 * the output deterministic regardless of block delivery order across NextToken
 * pages.
 */
function linesInReadingOrder(blocks: Block[]): string[] {
  const lines = blocks.filter((block) => block.BlockType === 'LINE' && block.Text);
  lines.sort((a, b) => {
    const pageA = a.Page ?? 0;
    const pageB = b.Page ?? 0;
    if (pageA !== pageB) {
      return pageA - pageB;
    }
    const topA = a.Geometry?.BoundingBox?.Top ?? 0;
    const topB = b.Geometry?.BoundingBox?.Top ?? 0;
    if (topA !== topB) {
      return topA - topB;
    }
    const leftA = a.Geometry?.BoundingBox?.Left ?? 0;
    const leftB = b.Geometry?.BoundingBox?.Left ?? 0;
    return leftA - leftB;
  });
  return lines.map((line) => line.Text!);
}

/**
 * Extract text from a PDF using Amazon Textract's asynchronous text detection.
 *
 * Starts a `StartDocumentTextDetection` job, polls `GetDocumentTextDetection`
 * (sleeping between polls, never busy-looping) until it finishes, follows every
 * `NextToken` to assemble all pages, and concatenates the LINE blocks in reading
 * order. The asynchronous API requires the document in S3;
 * {@link PdfExtractionOptions} requires either an explicit `documentLocation` or a
 * `stageDocument` callback that uploads the bytes.
 *
 * @throws if the Textract job fails or the poll budget is exhausted.
 */
export async function extractTextFromPdf(
  bytes: Uint8Array,
  options: PdfExtractionOptions,
): Promise<string> {
  const client = options.client ?? new TextractClient({});
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;
  const sleep = options.sleep ?? ((ms: number): Promise<void> => delay(ms));

  const s3Object = await resolveLocation(bytes, options);

  const start = await client.send(
    new StartDocumentTextDetectionCommand({ DocumentLocation: { S3Object: s3Object } }),
  );
  const jobId = start.JobId;
  if (!jobId) {
    throw new Error('Textract did not return a JobId for the document');
  }

  const terminal = await pollUntilDone(client, jobId, pollIntervalMs, maxPolls, sleep);
  const blocks = await collectBlocks(client, jobId, terminal);
  return linesInReadingOrder(blocks).join('\n');
}
