import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

const lambda = new LambdaClient({});

/**
 * Never throws. The DELETION record is the source of truth and the sweeper
 * re-drives anything PENDING, so a failed invoke delays the teardown but cannot
 * lose it — and the deletion is already committed by the time we get here.
 */
export async function invokeAccountDeletionWorker(orgId: string): Promise<void> {
  const functionName = process.env.ACCOUNT_DELETION_WORKER_FUNCTION_NAME;
  if (!functionName) {
    console.error('[account-deletion] ACCOUNT_DELETION_WORKER_FUNCTION_NAME unset', { orgId });
    return;
  }

  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ orgId })),
      }),
    );
  } catch (error) {
    console.error('[account-deletion] worker invoke failed; sweeper will pick it up', {
      orgId,
      error,
    });
  }
}
