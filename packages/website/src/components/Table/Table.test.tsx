import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Table } from '.';

describe('Table', () => {
  it('renders a table with header and body', () => {
    render(
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Name</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          <Table.Row>
            <Table.Cell>Alice</Table.Cell>
          </Table.Row>
        </Table.Body>
      </Table>,
    );
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  describe('sortable heads', () => {
    function renderHead(props: { onSort?: () => void; sortDirection?: 'asc' | 'desc' }) {
      render(
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head {...props}>Name</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            <Table.Row>
              <Table.Cell>Alice</Table.Cell>
            </Table.Row>
          </Table.Body>
        </Table>,
      );
      return document.querySelector('th')!;
    }

    it('stays inert with no onSort, and carries no aria-sort', () => {
      const th = renderHead({});
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(th).not.toHaveAttribute('aria-sort');
    });

    it('reports aria-sort none on a sortable but inactive column', () => {
      const th = renderHead({ onSort: () => {} });
      expect(screen.getByRole('button', { name: 'Name' })).toBeInTheDocument();
      expect(th).toHaveAttribute('aria-sort', 'none');
    });

    it('maps the sort direction onto aria-sort', () => {
      expect(renderHead({ onSort: () => {}, sortDirection: 'asc' })).toHaveAttribute(
        'aria-sort',
        'ascending',
      );
    });

    it('maps a descending sort onto aria-sort', () => {
      expect(renderHead({ onSort: () => {}, sortDirection: 'desc' })).toHaveAttribute(
        'aria-sort',
        'descending',
      );
    });

    it('calls onSort when the header is clicked', () => {
      const onSort = vi.fn();
      renderHead({ onSort });
      fireEvent.click(screen.getByRole('button', { name: 'Name' }));
      expect(onSort).toHaveBeenCalledOnce();
    });
  });
});
