import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, S3Region } from '@filone/shared';
import type { PrincipalAccessKey } from '@filone/shared';

vi.mock('./api.js', () => ({ getMe: () => new Promise(() => {}), apiRequest: vi.fn() }));

import { ToastProvider } from '../components/Toast/index.js';
import { useKeyRotation } from './use-key-rotation.js';
import { seedPermissions } from './test-permissions.js';

const USER_1 = '00000000-0000-0000-0000-000000000001';

describe('useKeyRotation', () => {
  it('lets a member rotate a principal-bound key with keys.create alone', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedPermissions(client, OrgRole.Member);
    const { result } = renderHook(() => useKeyRotation(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      ),
    });
    // `seedPermissions` writes userId USER_1.
    const boundToPrincipal: PrincipalAccessKey = {
      type: 'principal',
      id: 'key-1',
      keyName: 'laptop',
      accessKeyId: 'did:key:z1',
      createdAt: '2026-09-16T00:00:00Z',
      status: 'active',
      region: S3Region.UsEast9,
      createdBy: USER_1,
      principalId: USER_1,
    };

    expect(result.current.canRotate(boundToPrincipal)).toBe(true);
  });
});
