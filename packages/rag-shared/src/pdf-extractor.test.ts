import {
  type Block,
  GetDocumentTextDetectionCommand,
  type S3Object,
  StartDocumentTextDetectionCommand,
  TextractClient,
} from '@aws-sdk/client-textract';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { extractTextFromPdf, type PdfExtractionOptions } from './pdf-extractor.js';

const textractMock = mockClient(TextractClient);

function client(): TextractClient {
  return textractMock as unknown as TextractClient;
}

const LOCATION: S3Object = { Bucket: 'staging', Name: 'doc.pdf' };

function lineBlock(text: string, page: number, top: number, left = 0): Block {
  return {
    BlockType: 'LINE',
    Text: text,
    Page: page,
    Geometry: { BoundingBox: { Top: top, Left: left, Width: 1, Height: 0.1 } },
  };
}

describe('extractTextFromPdf', () => {
  beforeEach(() => {
    textractMock.reset();
  });

  it('starts a job with the S3 location and concatenates LINE blocks in reading order', async () => {
    textractMock.on(StartDocumentTextDetectionCommand).resolves({ JobId: 'job-1' });
    textractMock.on(GetDocumentTextDetectionCommand).resolves({
      JobStatus: 'SUCCEEDED',
      // Intentionally out of order to prove we sort by page then geometry.
      Blocks: [
        lineBlock('second line', 1, 0.5),
        lineBlock('first line', 1, 0.1),
        lineBlock('next page', 2, 0.1),
        { BlockType: 'WORD', Text: 'ignored', Page: 1 },
      ],
    });

    const text = await extractTextFromPdf(new Uint8Array([1, 2, 3]), {
      client: client(),
      documentLocation: LOCATION,
      pollIntervalMs: 1,
    });

    expect(text).toBe('first line\nsecond line\nnext page');

    const startCalls = textractMock.commandCalls(StartDocumentTextDetectionCommand);
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]!.args[0]!.input).toEqual({
      DocumentLocation: { S3Object: LOCATION },
    });
  });

  it('polls until the job leaves IN_PROGRESS, sleeping between polls (no busy-loop)', async () => {
    // Inject the delay and record the number of polls seen at the moment each
    // sleep is awaited. This proves a sleep falls *between* consecutive polls
    // (i.e. we await rather than busy-loop) without sleeping for real.
    const pollsAtSleep: number[] = [];
    const sleep = vi.fn(async (): Promise<void> => {
      pollsAtSleep.push(textractMock.commandCalls(GetDocumentTextDetectionCommand).length);
    });

    textractMock.on(StartDocumentTextDetectionCommand).resolves({ JobId: 'job-2' });
    textractMock
      .on(GetDocumentTextDetectionCommand)
      .resolvesOnce({ JobStatus: 'IN_PROGRESS' })
      .resolvesOnce({ JobStatus: 'IN_PROGRESS' })
      .resolves({ JobStatus: 'SUCCEEDED', Blocks: [lineBlock('done', 1, 0.1)] });

    const text = await extractTextFromPdf(new Uint8Array([1]), {
      client: client(),
      documentLocation: LOCATION,
      pollIntervalMs: 1234,
      sleep,
    });

    expect(text).toBe('done');
    // Three GET calls: two IN_PROGRESS then SUCCEEDED.
    expect(textractMock.commandCalls(GetDocumentTextDetectionCommand)).toHaveLength(3);
    // A delay was awaited after each non-terminal poll (two IN_PROGRESS) using
    // the configured interval, each interleaved between polls (after poll 1,
    // then after poll 2).
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1234);
    expect(pollsAtSleep).toEqual([1, 2]);
  });

  it('follows NextToken to assemble the full document text', async () => {
    textractMock.on(StartDocumentTextDetectionCommand).resolves({ JobId: 'job-3' });
    textractMock
      .on(GetDocumentTextDetectionCommand)
      // First (terminal) response carries a NextToken.
      .resolvesOnce({
        JobStatus: 'SUCCEEDED',
        Blocks: [lineBlock('page one a', 1, 0.1), lineBlock('page one b', 1, 0.2)],
        NextToken: 'tok-1',
      })
      .resolvesOnce({
        JobStatus: 'SUCCEEDED',
        Blocks: [lineBlock('page two a', 2, 0.1)],
        NextToken: 'tok-2',
      })
      .resolvesOnce({
        JobStatus: 'SUCCEEDED',
        Blocks: [lineBlock('page two b', 2, 0.2)],
      });

    const text = await extractTextFromPdf(new Uint8Array([1]), {
      client: client(),
      documentLocation: LOCATION,
      pollIntervalMs: 1,
    });

    expect(text).toBe('page one a\npage one b\npage two a\npage two b');

    const getCalls = textractMock.commandCalls(GetDocumentTextDetectionCommand);
    // 1 terminal poll + 2 NextToken follow-ups.
    expect(getCalls).toHaveLength(3);
    expect(getCalls[1]!.args[0]!.input.NextToken).toBe('tok-1');
    expect(getCalls[2]!.args[0]!.input.NextToken).toBe('tok-2');
  });

  it('stages the document when no explicit location is given', async () => {
    const stageDocument = vi.fn(async (_bytes: Uint8Array): Promise<S3Object> => LOCATION);
    textractMock.on(StartDocumentTextDetectionCommand).resolves({ JobId: 'job-4' });
    textractMock
      .on(GetDocumentTextDetectionCommand)
      .resolves({ JobStatus: 'SUCCEEDED', Blocks: [lineBlock('staged', 1, 0.1)] });

    const bytes = new Uint8Array([9, 9, 9]);
    const text = await extractTextFromPdf(bytes, {
      client: client(),
      stageDocument,
      pollIntervalMs: 1,
    });

    expect(text).toBe('staged');
    expect(stageDocument).toHaveBeenCalledTimes(1);
    expect(stageDocument.mock.calls[0]![0]).toBe(bytes);
    expect(textractMock.commandCalls(StartDocumentTextDetectionCommand)[0]!.args[0]!.input).toEqual(
      { DocumentLocation: { S3Object: LOCATION } },
    );
  });

  it('throws when neither documentLocation nor stageDocument is provided', async () => {
    // The options union makes this a compile-time error; the cast exercises the
    // defensive runtime guard that protects untyped JS callers.
    const optionsWithNeither = { client: client() } as unknown as PdfExtractionOptions;
    await expect(extractTextFromPdf(new Uint8Array([1]), optionsWithNeither)).rejects.toThrow(
      /documentLocation or stageDocument/,
    );
    expect(textractMock.commandCalls(StartDocumentTextDetectionCommand)).toHaveLength(0);
  });

  it('throws when the job fails', async () => {
    textractMock.on(StartDocumentTextDetectionCommand).resolves({ JobId: 'job-5' });
    textractMock
      .on(GetDocumentTextDetectionCommand)
      .resolves({ JobStatus: 'FAILED', StatusMessage: 'corrupt pdf' });

    await expect(
      extractTextFromPdf(new Uint8Array([1]), {
        client: client(),
        documentLocation: LOCATION,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(/failed: corrupt pdf/);
  });

  it('throws when the poll budget is exhausted', async () => {
    textractMock.on(StartDocumentTextDetectionCommand).resolves({ JobId: 'job-6' });
    textractMock.on(GetDocumentTextDetectionCommand).resolves({ JobStatus: 'IN_PROGRESS' });

    await expect(
      extractTextFromPdf(new Uint8Array([1]), {
        client: client(),
        documentLocation: LOCATION,
        pollIntervalMs: 1,
        maxPolls: 3,
      }),
    ).rejects.toThrow(/did not complete within 3 polls/);
    expect(textractMock.commandCalls(GetDocumentTextDetectionCommand)).toHaveLength(3);
  });

  it('throws when Textract does not return a JobId', async () => {
    textractMock.on(StartDocumentTextDetectionCommand).resolves({});
    await expect(
      extractTextFromPdf(new Uint8Array([1]), {
        client: client(),
        documentLocation: LOCATION,
      }),
    ).rejects.toThrow(/did not return a JobId/);
  });

  it('is deterministic: identical blocks yield identical output', async () => {
    const setup = (): void => {
      textractMock.reset();
      textractMock.on(StartDocumentTextDetectionCommand).resolves({ JobId: 'job-7' });
      textractMock.on(GetDocumentTextDetectionCommand).resolves({
        JobStatus: 'SUCCEEDED',
        Blocks: [lineBlock('b', 1, 0.5), lineBlock('a', 1, 0.1)],
      });
    };

    setup();
    const first = await extractTextFromPdf(new Uint8Array([1]), {
      client: client(),
      documentLocation: LOCATION,
      pollIntervalMs: 1,
    });
    setup();
    const second = await extractTextFromPdf(new Uint8Array([1]), {
      client: client(),
      documentLocation: LOCATION,
      pollIntervalMs: 1,
    });

    expect(first).toBe('a\nb');
    expect(second).toBe(first);
  });
});
