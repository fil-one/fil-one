import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createPortal } from 'react-dom';
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

  describe('rows with onActivate', () => {
    function renderRow(onActivate: () => void) {
      render(
        <Table>
          <Table.Body>
            <Table.Row onActivate={onActivate} data-testid="any-row">
              <Table.Cell>any text</Table.Cell>
              <Table.Cell>
                <Table.RowButton>any name</Table.RowButton>
                <input type="checkbox" aria-label="any checkbox" />
                <a href="#any">any link</a>
                {/* A menu or dialog opened from the row renders outside it. */}
                {createPortal(<p>any portaled text</p>, document.body)}
              </Table.Cell>
            </Table.Row>
          </Table.Body>
        </Table>,
      );
    }

    it('runs onActivate for a click on the row outside its controls', () => {
      const onActivate = vi.fn();
      renderRow(onActivate);

      fireEvent.click(screen.getByText('any text'));

      expect(onActivate).toHaveBeenCalledOnce();
    });

    it.each([
      ['a button', () => screen.getByRole('button', { name: 'any name' })],
      ['a checkbox', () => screen.getByRole('checkbox', { name: 'any checkbox' })],
      ['a link', () => screen.getByRole('link', { name: 'any link' })],
      ['content portaled out of the row', () => screen.getByText('any portaled text')],
    ])('leaves onActivate alone for a click on %s', (_case, target) => {
      const onActivate = vi.fn();
      renderRow(onActivate);

      fireEvent.click(target());

      expect(onActivate).not.toHaveBeenCalled();
    });

    // A row that is a button hides its cells from table navigation and nests
    // its own controls inside a control.
    it('keeps the row a row: no role and no tab stop', () => {
      renderRow(vi.fn());

      const row = screen.getByTestId('any-row');
      expect(row).not.toHaveAttribute('role');
      expect(row).not.toHaveAttribute('tabindex');
    });
  });
});
