import { describe, it, expect } from 'vitest';
import type { AuditEvent } from '@filone/shared';
import { AUDIT_CSV_COLUMNS, auditEventsToCsv, escapeCsvCell } from './audit-csv.js';

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function renamed(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    eventId: 'evt-1',
    type: 'org.renamed',
    actor: { kind: 'user', id: USER_ID, email: 'owner@example.com' },
    orgId: ORG_ID,
    subject: `org:${ORG_ID}`,
    details: { name: 'Acme Two', previousName: 'Acme' },
    createdAt: '2026-08-15T12:00:00.000Z',
    ttl: 1_770_000_000,
    ...overrides,
  } as AuditEvent;
}

/** The cells of one row, unquoted, so a test can name a field by position. */
function cells(row: string): string[] {
  return (row.match(/"(?:[^"]|"")*"/g) ?? []).map((cell) =>
    cell.slice(1, -1).replaceAll('""', '"'),
  );
}

function rows(csv: string): string[] {
  return csv.trimEnd().split('\r\n');
}

describe('escapeCsvCell', () => {
  it('quotes every value, so a comma or a newline cannot become structure', () => {
    expect(escapeCsvCell('Acme, Inc.')).toBe('"Acme, Inc."');
    expect(escapeCsvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('doubles an embedded quote, as RFC 4180 says', () => {
    expect(escapeCsvCell('say "hello"')).toBe('"say ""hello"""');
  });

  // An org name is free text a customer typed, and a spreadsheet executes a cell
  // that starts with one of these the moment the file is opened.
  it.each([
    ['=cmd|calc'],
    ['+1234'],
    ['-1+1'],
    ['@SUM(A1:A9)'],
    ['\tleading tab'],
    ['\rleading return'],
  ])('defuses %j with a leading apostrophe', (value) => {
    expect(escapeCsvCell(value)).toBe(`"'${value}"`);
  });

  it('defuses and quote-escapes together', () => {
    expect(escapeCsvCell('=HYPERLINK("http://attacker.example","Click")')).toBe(
      `"'=HYPERLINK(""http://attacker.example"",""Click"")"`,
    );
  });

  it('leaves an ordinary value alone', () => {
    expect(escapeCsvCell('Acme')).toBe('"Acme"');
  });

  // The guard has to sit inside the quoting: an apostrophe outside it would
  // leave a file that no longer parses as CSV.
  it('keeps the guard inside the quotes', () => {
    expect(escapeCsvCell('=1,2')).toBe(`"'=1,2"`);
  });
});

describe('auditEventsToCsv', () => {
  it('leads with the column header', () => {
    expect(cells(rows(auditEventsToCsv([]))[0])).toEqual([...AUDIT_CSV_COLUMNS]);
  });

  it('writes the envelope and the payload as JSON', () => {
    const csv = auditEventsToCsv([renamed()]);

    expect(cells(rows(csv)[1])).toEqual([
      'evt-1',
      '2026-08-15T12:00:00.000Z',
      'org.renamed',
      'user',
      USER_ID,
      'owner@example.com',
      `org:${ORG_ID}`,
      // No phase, outcome, or correlation id on a single-phase event.
      '',
      '',
      '',
      '{"name":"Acme Two","previousName":"Acme"}',
    ]);
  });

  it('carries both halves of a two-phase event on their shared correlation id', () => {
    const csv = auditEventsToCsv([
      renamed({
        type: 'key.created',
        details: { keyKind: 's3', keyName: 'ci', keyIdSuffix: 'MPLE' },
        phase: 'completion',
        correlationId: 'corr-1',
        outcome: 'succeeded',
      } as Partial<AuditEvent>),
    ]);

    const row = cells(rows(csv)[1]);
    expect([row[7], row[8], row[9]]).toEqual(['completion', 'succeeded', 'corr-1']);
  });

  // The attack the writer exists to stop: an org renames itself to a formula, and
  // the export has to reach an auditor's spreadsheet as text. Here the JSON
  // wrapper is what does it — the cell opens with `{`, so the formula is not in
  // the position a spreadsheet evaluates — and the assertion is that the cell
  // never begins with the trigger, whichever of the two rules got it there.
  it('keeps a formula a customer typed into an org name out of the evaluated position', () => {
    const csv = auditEventsToCsv([
      renamed({ details: { name: '=HYPERLINK("http://attacker.example","Payroll")' } }),
    ]);

    const detailsCell = cells(rows(csv)[1]).at(-1)!;
    expect(detailsCell.startsWith('{')).toBe(true);
    expect(JSON.parse(detailsCell)).toEqual({
      name: '=HYPERLINK("http://attacker.example","Payroll")',
    });
  });

  // The same attack where the guard itself is what stops it. An email local-part
  // may legally contain `=`, so a verified address can land at the front of a
  // cell already looking like a formula.
  it('defuses a formula that reaches the front of a cell', () => {
    const csv = auditEventsToCsv([
      renamed({ actor: { kind: 'user', id: USER_ID, email: '=1+1@example.com' } }),
    ]);

    expect(cells(rows(csv)[1])[5]).toBe("'=1+1@example.com");
  });

  it('never opens a cell with a formula trigger', () => {
    const csv = auditEventsToCsv([
      renamed({
        details: { name: '=1+1', previousName: '@SUM(A1)' },
        actor: { kind: 'user', id: USER_ID, email: '+admin@example.com' },
        subject: `org:${ORG_ID}`,
      }),
    ]);

    for (const row of rows(csv)) {
      for (const cell of cells(row)) {
        expect(['=', '+', '-', '@', '\t', '\r']).not.toContain(cell.charAt(0));
      }
    }
  });

  it('emits createdAt exactly as stored, never localized', () => {
    const csv = auditEventsToCsv([renamed({ createdAt: '2026-01-01T00:00:00.000Z' })]);

    expect(cells(rows(csv)[1])[1]).toBe('2026-01-01T00:00:00.000Z');
  });

  it('uses CRLF, so the file opens cleanly where auditors are', () => {
    expect(auditEventsToCsv([renamed()])).toMatch(/\r\n/);
  });

  it('writes a header and nothing else for an empty result', () => {
    expect(rows(auditEventsToCsv([]))).toHaveLength(1);
  });
});
