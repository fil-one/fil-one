import { act, render, renderHook } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';

import { S3Region, type S3ObjectVersion } from '@filone/shared';

import type { ObjectDetailsDrawerProps } from '../components/ObjectDetailsDrawer';

const { navigate, historyBack } = vi.hoisted(() => ({
  navigate: vi.fn(),
  historyBack: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouter: () => ({ history: { back: historyBack } }),
}));

// The panel itself has its own tests; here it only reports the props it was given
const { drawerProps } = vi.hoisted(() => ({
  drawerProps: { current: undefined as ObjectDetailsDrawerProps | undefined },
}));
vi.mock('../components/ObjectDetailsDrawer', () => ({
  ObjectDetailsDrawer: (props: ObjectDetailsDrawerProps) => {
    drawerProps.current = props;
    return null;
  },
}));

const { prefetchObjectMetadata, removeObjectMetadata } = vi.hoisted(() => ({
  prefetchObjectMetadata: vi.fn(),
  removeObjectMetadata: vi.fn(),
}));
vi.mock('../lib/object-metadata.js', () => ({ prefetchObjectMetadata, removeObjectMetadata }));

// Deleting succeeds at once and reports the deleted version, as S3 accepting it would
vi.mock('../lib/use-object-actions.js', () => ({
  useObjectActions: ({ onDeleted }: { onDeleted: (key: string, versionId?: string) => void }) => ({
    deleteObject: (key: string, versionId?: string) => {
      onDeleted(key, versionId);
      return Promise.resolve();
    },
  }),
}));

import {
  BucketObjectDrawer,
  toOpenObject,
  useObjectDrawerNavigation,
  type BucketObjectDrawerProps,
} from './BucketObjectDrawer';

afterEach(() => {
  vi.clearAllMocks();
  drawerProps.current = undefined;
});

function version(overrides: Partial<S3ObjectVersion>): S3ObjectVersion {
  return {
    key: 'any-key',
    versionId: 'any-version',
    sizeBytes: 1,
    lastModified: '2026-10-21T14:32:00Z',
    isLatest: false,
    isDeleteMarker: false,
    ...overrides,
  };
}

const versions = [
  version({ versionId: 'latest-version', isLatest: true }),
  version({ versionId: 'older-version' }),
];

describe('toOpenObject', () => {
  it.each([
    // A bucket without versioning lists every row with an empty ID
    ['the empty ID of an unversioned bucket', [version({ versionId: '', isLatest: true })], ''],
    ["the latest version's own ID", versions, 'latest-version'],
  ])('opens the object itself for %s', (_case, listing, versionId) => {
    expect(toOpenObject(listing, 'any-key', versionId)).toStrictEqual({ key: 'any-key' });
  });

  it('opens an older version by its ID', () => {
    expect(toOpenObject(versions, 'any-key', 'older-version')).toStrictEqual({
      key: 'any-key',
      versionId: 'older-version',
    });
  });

  it.each([
    ['beside the latest', [...versions, version({ versionId: '' })]],
    // A listing page that resumes partway through the key's history
    [
      'on a page without the latest',
      [version({ versionId: 'older-version' }), version({ versionId: '' })],
    ],
  ])(
    'opens the version saved before versioning was turned on by S3\'s "null" ID, %s',
    (_case, listing) => {
      // The listing writes that version's "null" ID as ''
      expect(toOpenObject(listing, 'any-key', '')).toStrictEqual({
        key: 'any-key',
        versionId: 'null',
      });
    },
  );
});

describe('useObjectDrawerNavigation', () => {
  function renderNavigation() {
    return renderHook(() =>
      useObjectDrawerNavigation('any-bucket', S3Region.EuWest1, 'any-folder/'),
    ).result.current;
  }

  it('adds a history entry naming the object and version when the panel opens', () => {
    renderNavigation().open({ key: 'any-folder/a.txt', versionId: 'any-version' });

    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: '/buckets/$bucketName',
      params: { bucketName: 'any-bucket' },
      search: {
        region: S3Region.EuWest1,
        prefix: 'any-folder/',
        object: 'any-folder/a.txt',
        version: 'any-version',
      },
      replace: false,
    });
  });

  it('replaces the history entry when stepping to another object', () => {
    renderNavigation().step({ key: 'any-folder/b.txt' });

    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        search: { region: S3Region.EuWest1, prefix: 'any-folder/', object: 'any-folder/b.txt' },
        replace: true,
      }),
    );
  });

  it('goes back when closing a panel opened from the list', () => {
    const navigation = renderNavigation();
    navigation.open({ key: 'any-folder/a.txt' });
    navigate.mockClear();

    navigation.close();

    expect(historyBack).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('replaces the URL without the object when closing a panel that came in with the page', () => {
    renderNavigation().close();

    expect(historyBack).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        search: { region: S3Region.EuWest1, prefix: 'any-folder/' },
        replace: true,
      }),
    );
  });
});

describe('BucketObjectDrawer', () => {
  const folder = [
    version({ key: 'any-folder/a.txt', isLatest: true }),
    version({ key: 'any-folder/b.txt', isLatest: true }),
    version({ key: 'any-folder/c.txt', isLatest: true }),
  ];

  function renderDrawer(overrides: Partial<BucketObjectDrawerProps>) {
    const navigation = { open: vi.fn(), step: vi.fn(), close: vi.fn() };
    const onDeleted = vi.fn();
    render(
      <BucketObjectDrawer
        bucketName="any-bucket"
        region={S3Region.EuWest1}
        versions={folder}
        currentPrefix="any-folder/"
        openObject={{ key: 'any-folder/b.txt' }}
        versioningEnabled={false}
        objectLockEnabled={false}
        onDownload={vi.fn()}
        onDeleted={onDeleted}
        navigation={navigation}
        {...overrides}
      />,
    );
    return { navigation, onDeleted, props: drawerProps.current! };
  }

  it("counts the open object among the folder's objects", () => {
    const { props } = renderDrawer({});

    expect(props.siblings).toMatchObject({ position: 2, total: 3 });
  });

  it.each([
    ['previous', 'onPrevious', 'any-folder/a.txt'],
    ['next', 'onNext', 'any-folder/c.txt'],
  ] as const)("steps to the %s object in the table's order", (_case, handler, key) => {
    const { navigation, props } = renderDrawer({});

    props.siblings?.[handler]?.();

    expect(navigation.step).toHaveBeenCalledExactlyOnceWith({ key });
  });

  it.each([
    ['previous on the first object', 'any-folder/a.txt', 'onPrevious'],
    ['next on the last object', 'any-folder/c.txt', 'onNext'],
  ] as const)('offers no %s', (_case, key, handler) => {
    const { props } = renderDrawer({ openObject: { key } });

    expect(props.siblings?.[handler]).toBeUndefined();
  });

  it("loads the neighbours' details ahead of a step", () => {
    renderDrawer({});

    expect(prefetchObjectMetadata.mock.calls).toStrictEqual([
      [{ bucketName: 'any-bucket', region: S3Region.EuWest1, objectKey: 'any-folder/a.txt' }],
      [{ bucketName: 'any-bucket', region: S3Region.EuWest1, objectKey: 'any-folder/c.txt' }],
    ]);
  });

  it("drops the object's cached details, refreshes the list and closes after a delete", async () => {
    const { navigation, onDeleted, props } = renderDrawer({
      openObject: { key: 'any-folder/b.txt', versionId: 'any-version' },
    });

    await act(() => props.onDelete());

    expect(removeObjectMetadata).toHaveBeenCalledExactlyOnceWith('any-bucket', 'any-folder/b.txt');
    expect(onDeleted).toHaveBeenCalledExactlyOnceWith('any-folder/b.txt', 'any-version');
    expect(navigation.close).toHaveBeenCalledOnce();
  });
});
