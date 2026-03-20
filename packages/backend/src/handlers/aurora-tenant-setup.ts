// Must be the first import — registers the OTel TracerProvider before any other module loads.
import '../lib/instrumentation.js';

import assert from 'node:assert';
import type { SQSEvent, Context } from 'aws-lambda';
import { processTenantSetup } from '../lib/aurora-tenant-setup.js';
import type { AuroraTenantSetupMessage } from '../lib/aurora-tenant-setup.js';
import { tracedHandler } from '../middleware/tracing.js';

async function baseHandler(event: SQSEvent, _context: Context): Promise<void> {
  assert.equal(
    event.Records.length,
    1,
    `Expected exactly 1 SQS record, got ${event.Records.length}`,
  );
  const message: AuroraTenantSetupMessage = JSON.parse(event.Records[0].body);
  await processTenantSetup(message);
}

export const handler = tracedHandler(baseHandler);
