import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PROD_CONSOLE_ALIAS_HOSTS, Stage } from '@filone/shared';

describe('inferStage', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns Production when hostname is the canonical host app.filone.com', async () => {
    vi.stubGlobal('window', { location: { hostname: 'app.filone.com' } });
    const { FILONE_STAGE } = await import('./env.js');
    expect(FILONE_STAGE).toBe(Stage.Production);
  });

  // The aliases serve the production bundle, so the stage inferred in the
  // browser has to match. Getting this wrong would show production users staging
  // S3 endpoints to copy into their tooling and expose non-GA regions.
  for (const hostname of PROD_CONSOLE_ALIAS_HOSTS) {
    it(`returns Production when hostname is the alias ${hostname}`, async () => {
      vi.stubGlobal('window', { location: { hostname } });
      const { FILONE_STAGE } = await import('./env.js');
      expect(FILONE_STAGE).toBe(Stage.Production);
    });
  }

  it('returns Staging for any other hostname', async () => {
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    const { FILONE_STAGE } = await import('./env.js');
    expect(FILONE_STAGE).toBe(Stage.Staging);
  });
});
