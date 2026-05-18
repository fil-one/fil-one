import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Stage } from '@filone/shared';

describe('inferStage', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns Production when hostname is app.fil.one', async () => {
    vi.stubGlobal('window', { location: { hostname: 'app.fil.one' } });
    const { FILONE_STAGE } = await import('./env.js');
    expect(FILONE_STAGE).toBe(Stage.Production);
  });

  it('returns Staging for any other hostname', async () => {
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    const { FILONE_STAGE } = await import('./env.js');
    expect(FILONE_STAGE).toBe(Stage.Staging);
  });
});
