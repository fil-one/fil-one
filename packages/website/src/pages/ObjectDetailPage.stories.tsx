import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import { S3Region, SubscriptionStatus } from '@filone/shared';
import type { ObjectMetadataResponse, S3ObjectVersion } from '@filone/shared';

import { ObjectDetailPage } from './ObjectDetailPage';
import { queryKeys } from '../lib/query-client.js';

const BUCKET = 'any-bucket';
const REGION = S3Region.UsEast1;

// A stand-in image, inline so the story needs no network
const SAMPLE_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c7d2fe"/><stop offset="1" stop-color="#1e3a8a"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="820" cy="300" r="140" fill="#e0e7ff" opacity=".8"/></svg>',
)}`;

type Scenario = {
  objectKey: string;
  metadata?: Partial<ObjectMetadataResponse>;
  previewUrl?: string;
  previewText?: { text: string; truncated: boolean };
  /** The version in the URL, for the older-version states. */
  versionId?: string;
  /** The object's history, newest first. Empty for a bucket without versioning. */
  versions?: S3ObjectVersion[];
  objectLockEnabled?: boolean;
  /**
   * Leaves the object's details unseeded and stubs `fetch` while the story is
   * mounted: `loading` never answers, `error` answers every request with a 500. (A 403
   * would go through the permission refresh, which never settles without a server.)
   */
  network?: 'loading' | 'error';
};

// Restores the real fetch; set while a stubbed story is mounted
let stubbedFetchRestore: (() => void) | undefined;

/**
 * The network as the story needs it, put back when the story unmounts. Only the
 * loading and error states use it; every other story is fully seeded.
 */
function useStubbedFetch(network: Scenario['network']) {
  useState(() => {
    if (!network) return null;
    const realFetch = window.fetch;
    window.fetch = () =>
      network === 'loading'
        ? new Promise<Response>(() => {})
        : Promise.resolve(
            new Response(
              JSON.stringify({ message: 'Storage is temporarily unavailable. Try again shortly.' }),
              {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
              },
            ),
          );
    stubbedFetchRestore = () => {
      window.fetch = realFetch;
    };
    return null;
  });
  useEffect(() => () => stubbedFetchRestore?.(), []);
}

function version(overrides: Partial<S3ObjectVersion>): S3ObjectVersion {
  return {
    key: 'any-key',
    versionId: 'any-version',
    sizeBytes: 2_097_152,
    lastModified: '2026-10-21T14:32:00Z',
    isLatest: false,
    isDeleteMarker: false,
    ...overrides,
  };
}

function metadataFor(scenario: Scenario): ObjectMetadataResponse {
  return {
    key: scenario.objectKey,
    sizeBytes: 2_097_152,
    lastModified: '2026-10-21T14:32:00Z',
    etag: '"1de267f54f14b8690462c8a1b8ffa208"',
    contentType: 'image/png',
    metadata: {},
    ...scenario.metadata,
  };
}

/**
 * Seeds the queries the page reads, marked fresh so nothing refetches against
 * a server the story does not have.
 */
function Seeded({ scenario, children }: { scenario: Scenario; children: React.ReactNode }) {
  const client = useQueryClient();
  useStubbedFetch(scenario.network);
  useState(() => {
    const { objectKey, versionId } = scenario;
    const metadataKey = queryKeys.objectMetadata(BUCKET, objectKey, versionId);
    const previewKey = queryKeys.objectPreviewUrl(BUCKET, objectKey, versionId);
    const versionsKey = queryKeys.objectVersions(BUCKET, REGION, objectKey);
    const bucketKey = queryKeys.bucket(BUCKET, REGION);
    for (const key of [metadataKey, previewKey, versionsKey, bucketKey]) {
      client.setQueryDefaults(key, { staleTime: Infinity });
    }
    if (!scenario.network) client.setQueryData(metadataKey, metadataFor(scenario));
    client.setQueryData(versionsKey, scenario.versions ?? []);
    client.setQueryData(bucketKey, {
      bucket: {
        bucketName: BUCKET,
        region: REGION,
        isPublic: false,
        objectLockEnabled: scenario.objectLockEnabled ?? false,
      },
    });
    if (scenario.previewUrl) client.setQueryData(previewKey, scenario.previewUrl);
    if (scenario.previewText) client.setQueryData([...previewKey, 'text'], scenario.previewText);
    return null;
  });
  return <>{children}</>;
}

function renderPage(scenario: Scenario) {
  const rootRoute = createRootRoute();
  const objectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName/objects',
    component: () => (
      <ObjectDetailPage
        bucketName={BUCKET}
        region={REGION}
        objectKey={scenario.objectKey}
        versionId={scenario.versionId}
      />
    ),
  });
  const bucketRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([objectRoute, bucketRoute]),
    history: createMemoryHistory({ initialEntries: [`/buckets/${BUCKET}/objects`] }),
  });
  return (
    <Seeded scenario={scenario}>
      <RouterProvider router={router} />
    </Seeded>
  );
}

const meta: Meta = {
  title: 'Pages/ObjectDetailPage',
  // A paid plan, so Share is enabled as it is for most callers
  parameters: { layout: 'fullscreen', billingStatus: SubscriptionStatus.Active },
};

export default meta;
type Story = StoryObj;

export const Image: Story = {
  render: () =>
    renderPage({
      objectKey:
        'spacepunkbg/a_brilliant_clean_bright_white_plastic_space_station_window_n_74ac044b-3881-4f6f-a4f1-68dc98a5500b_0.png',
      previewUrl: SAMPLE_IMAGE,
      metadata: {
        metadata: { tags: JSON.stringify(['backgrounds', 'space']), source: 'any-generator' },
      },
    }),
};

export const Text: Story = {
  render: () =>
    renderPage({
      objectKey: 'any-folder/config.json',
      metadata: { contentType: 'application/json', sizeBytes: 412 },
      previewUrl: 'about:blank',
      previewText: {
        text: JSON.stringify({ name: 'any-service', replicas: 3, regions: ['us-east-1'] }, null, 2),
        truncated: false,
      },
    }),
};

export const UnsupportedType: Story = {
  render: () =>
    renderPage({
      objectKey: 'any-archive.zip',
      metadata: { contentType: 'application/zip', sizeBytes: 48_000_000 },
    }),
};

export const TooLargeToPreview: Story = {
  render: () =>
    renderPage({
      objectKey: 'any-folder/any-scan.tiff',
      metadata: { contentType: 'image/tiff', sizeBytes: 240_000_000 },
    }),
};

export const ComplianceRetention: Story = {
  render: () =>
    renderPage({
      objectLockEnabled: true,
      objectKey: 'any-ledger.csv',
      metadata: {
        contentType: 'text/csv',
        sizeBytes: 2_400_000,
        retention: { mode: 'COMPLIANCE', retainUntilDate: '2027-10-21T00:00:00Z' },
      },
    }),
};

const HISTORY_KEY = 'any-folder/any-report.pdf';
const history = [
  version({ key: HISTORY_KEY, versionId: '3f9a1c7e5b2d4f60', isLatest: true }),
  version({
    key: HISTORY_KEY,
    versionId: '8b2e6d40c19a7f35',
    lastModified: '2026-10-14T09:05:00Z',
    sizeBytes: 1_980_000,
  }),
  version({
    key: HISTORY_KEY,
    versionId: 'c4d7a9e2f0b61835',
    lastModified: '2026-09-30T17:48:00Z',
    sizeBytes: 1_720_000,
  }),
];

export const LatestOfSeveralVersions: Story = {
  render: () =>
    renderPage({
      objectKey: HISTORY_KEY,
      metadata: { contentType: 'application/pdf' },
      versions: history,
    }),
};

export const OlderVersion: Story = {
  render: () =>
    renderPage({
      objectKey: HISTORY_KEY,
      versionId: '8b2e6d40c19a7f35',
      metadata: { contentType: 'application/pdf', lastModified: '2026-10-14T09:05:00Z' },
      versions: history,
    }),
};

export const VersionOfDeletedObject: Story = {
  render: () =>
    renderPage({
      objectKey: HISTORY_KEY,
      versionId: '8b2e6d40c19a7f35',
      metadata: { contentType: 'application/pdf', lastModified: '2026-10-14T09:05:00Z' },
      versions: [
        version({
          key: HISTORY_KEY,
          versionId: 'e1f2a3b4c5d6e7f8',
          isLatest: true,
          isDeleteMarker: true,
        }),
        ...history.map((v) => ({ ...v, isLatest: false })),
      ],
    }),
};

export const Loading: Story = {
  render: () => renderPage({ objectKey: 'any-folder/any-file.png', network: 'loading' }),
};

export const FailedToLoad: Story = {
  render: () => renderPage({ objectKey: 'any-folder/any-file.png', network: 'error' }),
};

export const PreviewFailed: Story = {
  render: () =>
    renderPage({
      objectKey: 'any-folder/any-photo.png',
      // Not an image, so the browser's load fails the way a broken file would
      previewUrl: 'data:image/png;base64,bm90LWFuLWltYWdl',
    }),
};

export const TruncatedText: Story = {
  render: () =>
    renderPage({
      objectKey: 'any-folder/any-server.log',
      metadata: { contentType: 'text/plain', sizeBytes: 640_000 },
      previewUrl: 'about:blank',
      previewText: {
        text: Array.from(
          { length: 400 },
          (_, i) =>
            `2026-10-21T14:${String(i % 60).padStart(2, '0')}:00Z INFO request ${i} served in ${(i * 7) % 90}ms`,
        ).join('\n'),
        truncated: true,
      },
    }),
};

/** A one-second tone as a WAV file, so the audio story needs no network. */
function makeToneUrl(): string {
  const sampleRate = 8000;
  const samples = sampleRate;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  // The WAV header's tags are ASCII, so one character is one byte
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  writeText(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    view.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000, true);
  }
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

/** A one-second clip recorded from a canvas, so the video story needs no network. */
async function makeClipUrl(): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext('2d');
  const recorder = new MediaRecorder(canvas.captureStream(24), { mimeType: 'video/webm' });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.start();
  const started = performance.now();
  // A timer rather than requestAnimationFrame, which a background tab pauses:
  // the story would wait forever for a clip that never finishes recording
  await new Promise<void>((resolve) => {
    const timer = window.setInterval(() => {
      const t = (performance.now() - started) / 1000;
      if (context) {
        context.fillStyle = '#1e3a8a';
        context.fillRect(0, 0, 640, 360);
        context.fillStyle = '#e0e7ff';
        context.beginPath();
        context.arc(120 + t * 400, 180, 60, 0, Math.PI * 2);
        context.fill();
      }
      if (t >= 1) {
        window.clearInterval(timer);
        resolve();
      }
    }, 40);
  });
  recorder.stop();
  await stopped;
  return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
}

export const Video: Story = {
  loaders: [async () => ({ clipUrl: await makeClipUrl() })],
  render: (_args, { loaded }) =>
    renderPage({
      objectKey: 'any-folder/any-clip.webm',
      metadata: { contentType: 'video/webm', sizeBytes: 84_000_000 },
      previewUrl: String(loaded.clipUrl),
    }),
};

export const Audio: Story = {
  render: () =>
    renderPage({
      objectKey: 'any-folder/any-tone.wav',
      metadata: { contentType: 'audio/wav', sizeBytes: 16_044 },
      previewUrl: makeToneUrl(),
    }),
};

export const GovernanceRetention: Story = {
  render: () =>
    renderPage({
      objectLockEnabled: true,
      objectKey: 'any-folder/any-invoice.pdf',
      metadata: {
        contentType: 'application/pdf',
        sizeBytes: 380_000,
        retention: { mode: 'GOVERNANCE', retainUntilDate: '2027-04-01T00:00:00Z' },
      },
    }),
};

export const UnversionedBucket: Story = {
  render: () =>
    renderPage({
      objectKey: 'any-notes.txt',
      metadata: { contentType: 'text/plain', sizeBytes: 1_204 },
      // S3 gives every object in a bucket without versioning the version ID "null"
      versions: [version({ key: 'any-notes.txt', versionId: 'null', isLatest: true })],
      previewUrl: 'about:blank',
      previewText: {
        text: 'Meeting notes\n\n- Ship the object page\n- Review the stories',
        truncated: false,
      },
    }),
};
