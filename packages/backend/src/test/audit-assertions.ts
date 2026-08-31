import { expect } from 'vitest';
import type { AttributeValue, TransactWriteItem } from '@aws-sdk/client-dynamodb';
import {
  CREDENTIAL_VALUE_PATTERNS,
  PROHIBITED_AUDIT_FIELD_PATTERNS,
  looksLikeCredential,
} from '@filone/shared';

/**
 * Helpers the wiring tests share, so what "the event landed" and "the event
 * carries no secret" mean is settled once.
 *
 * The table name matches `sstResourceMock`, which is where AuditTable is
 * declared for tests.
 */
const AUDIT_TABLE_NAME = 'AuditTable';

/**
 * The audit item out of a transaction, found by table rather than by position.
 *
 * Indexing into `TransactItems` couples every assertion to the order a handler
 * happens to build its items in: adding a row ahead of the event silently moves
 * the assertion onto the wrong item and it keeps passing.
 */
export function auditItemIn(
  items: TransactWriteItem[] | undefined,
): Record<string, AttributeValue> {
  const audit = (items ?? []).filter((item) => item.Put?.TableName === AUDIT_TABLE_NAME);
  expect(audit, 'the transaction carries exactly one audit event').toHaveLength(1);
  return audit[0].Put!.Item!;
}

/** Whether a transaction carries an audit event at all. */
export function hasAuditItem(items: TransactWriteItem[] | undefined): boolean {
  return (items ?? []).some((item) => item.Put?.TableName === AUDIT_TABLE_NAME);
}

/**
 * Assert a marshalled item carries no credential, by name or by shape.
 *
 * Both halves, because either alone passes something: a field called
 * `keyIdSuffix` holding a whole secret access key, or a field called `note`
 * holding the token. Stated over the marshalled item so it checks what actually
 * goes to DynamoDB rather than what the handler meant to send.
 */
export function expectNoSecrets(item: Record<string, AttributeValue>): void {
  for (const [path, value] of flatten(item)) {
    const field = path.split(/[.[]/).at(-1) ?? path;
    const deniedName = PROHIBITED_AUDIT_FIELD_PATTERNS.find((pattern) => pattern.test(field));
    expect(deniedName, `${path} is named for prohibited content`).toBeUndefined();

    if (typeof value === 'string') {
      const shape = CREDENTIAL_VALUE_PATTERNS.find((pattern) => pattern.test(value));
      expect(shape, `${path} holds something shaped like a credential`).toBeUndefined();
      expect(looksLikeCredential(value), `${path} holds something shaped like a credential`).toBe(
        false,
      );
    }
  }
}

/** Every attribute in a marshalled item, as `path` / scalar pairs. */
function flatten(
  value: Record<string, AttributeValue>,
  prefix = '',
): [string, string | number | boolean | null][] {
  const found: [string, string | number | boolean | null][] = [];

  for (const [field, attribute] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${field}` : field;
    if (attribute.S !== undefined) found.push([path, attribute.S]);
    else if (attribute.N !== undefined) found.push([path, Number(attribute.N)]);
    else if (attribute.BOOL !== undefined) found.push([path, attribute.BOOL]);
    else if (attribute.M) found.push(...flatten(attribute.M, path));
    else if (attribute.L) {
      attribute.L.forEach((entry, index) => {
        found.push(...flatten({ [`${index}`]: entry }, path));
      });
    }
  }

  return found;
}
