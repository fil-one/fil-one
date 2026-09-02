import {
  ArrowSquareOutIcon,
  DownloadSimpleIcon,
  ReceiptIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { Invoice } from '@filone/shared';

import { Alert } from '../Alert';
import { Badge } from '../Badge';
import { Button } from '../Button';
import type { BadgeColor } from '../Badge';
import { EmptyStateCard } from '../EmptyStateCard';
import { Table } from '../Table/Table';
import { formatDate } from '../../lib/time.js';
import { formatCents } from '../../lib/billing-view.js';

export type InvoicesCardProps = {
  invoices?: Invoice[];
  loading: boolean;
  errorMessage?: string;
  /**
   * Opens Stripe's portal, where the full archive lives. Absent for a caller
   * without `billing.manage`, which is what the portal requires.
   */
  onViewAll?: () => void;
};

/**
 * What has been billed, in the table every other list in the console uses.
 *
 * The hand-rolled rows this replaces carried their own dividers, their own
 * PDF-link styling, and a lowercase status word where the rest of the console
 * uses a badge. A table gets the column widths, the hover, and the responsive
 * behaviour for free, and an invoice list is a list.
 *
 * Every issued invoice appears, unpaid ones included. The list used to be
 * filtered to `paid`, which hid the single invoice a customer with a failed
 * payment came here to find.
 */
export function InvoicesCard({ invoices, loading, errorMessage, onViewAll }: InvoicesCardProps) {
  if (loading) {
    return (
      <div
        className="animate-pulse rounded-xl border border-zinc-200 bg-white p-5 shadow-xs"
        data-testid="invoices-loading"
      >
        <div className="mb-4 h-4 w-24 rounded bg-zinc-200" />
        <div className="mb-3 h-4 w-full rounded bg-zinc-200" />
        <div className="mb-3 h-4 w-full rounded bg-zinc-200" />
        <div className="h-4 w-full rounded bg-zinc-200" />
      </div>
    );
  }

  if (errorMessage) {
    return <Alert variant="red" title="Unable to load invoices" description={errorMessage} />;
  }

  if (!invoices || invoices.length === 0) {
    return (
      <EmptyStateCard
        icon={ReceiptIcon}
        iconColor="grey"
        title="No invoices yet"
        description="Invoices appear here once your first billing period closes."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* The action rides the title row, the way the cards above it do, and is
          pulled back to the title's line box so it does not set the row's
          height. */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h3 className="text-sm font-medium text-zinc-900">Invoices</h3>
        {/* The list is capped at a year of invoices in one Stripe call. Rather
            than paginate a second copy of Stripe's archive, the console points
            at the archive itself. */}
        {onViewAll && (
          <Button
            variant="tertiary"
            size="sm"
            className="-my-1.5"
            icon={ArrowSquareOutIcon}
            iconPosition="right"
            onClick={onViewAll}
          >
            View all
          </Button>
        )}
      </div>
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Date</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head className="text-right">Amount</Table.Head>
            <Table.Head>
              <span className="sr-only">Download</span>
            </Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {invoices.map((invoice) => (
            <Table.Row key={invoice.id} data-testid="invoice-row" data-invoice-id={invoice.id}>
              <Table.Cell className="text-xs font-medium whitespace-nowrap text-zinc-900">
                {formatDate(invoice.createdAt)}
              </Table.Cell>
              <Table.Cell>
                <Badge color={statusTone(invoice.status)} size="sm" weight="medium">
                  {statusLabel(invoice.status)}
                </Badge>
              </Table.Cell>
              <Table.Cell className="text-right text-xs tabular-nums whitespace-nowrap">
                {/* A voided invoice was cancelled, so it is owed nothing rather
                    than owed zero. `$0.00` in a money column reads as a charge
                    that happened to come to nothing; the dash says there is no
                    figure, and the screen reader gets the sentence. */}
                {invoice.status === 'void' ? (
                  <>
                    <span aria-hidden="true" className="text-zinc-500">
                      &ndash;
                    </span>
                    <span className="sr-only">No amount due</span>
                  </>
                ) : (
                  formatCents(invoice.amountDueInCents)
                )}
              </Table.Cell>
              <Table.Cell className="text-right">
                {/* The same tertiary button the cards above use, and the
                    download glyph rather than the external arrow: this hands
                    over a file, it does not navigate anywhere. */}
                {invoice.invoicePdfUrl && (
                  <Button
                    variant="tertiary"
                    size="sm"
                    href={invoice.invoicePdfUrl}
                    icon={DownloadSimpleIcon}
                    externalIcon={false}
                    aria-label={`Download the ${formatDate(invoice.createdAt)} invoice for ${formatCents(invoice.amountDueInCents)}`}
                  >
                    PDF
                  </Button>
                )}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

/**
 * An invoice's state in the console's own words. Stripe's vocabulary leaks
 * otherwise: `open` means unpaid and `uncollectible` means written off, and
 * neither says that to somebody reading their own bill.
 */
function statusLabel(status: Invoice['status']): string {
  switch (status) {
    case 'paid':
      return 'Paid';
    case 'open':
      return 'Due';
    case 'draft':
      return 'Draft';
    case 'void':
      return 'Void';
    case 'uncollectible':
      return 'Unpaid';
    default:
      return 'Unknown';
  }
}

function statusTone(status: Invoice['status']): BadgeColor {
  switch (status) {
    case 'paid':
      return 'green';
    case 'open':
      return 'amber';
    case 'uncollectible':
      return 'red';
    default:
      return 'grey';
  }
}
