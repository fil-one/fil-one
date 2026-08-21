import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { FolderOpenIcon } from '@phosphor-icons/react/dist/ssr';

import { IconBox } from '../IconBox';
import { Table } from './Table';

const meta: Meta<typeof Table> = {
  title: 'Components/Table',
  component: Table,
};

export default meta;
type Story = StoryObj<typeof Table>;

const sampleData = [
  { name: 'my-bucket', objects: 142, size: '2.3 GB', created: '2026-01-15' },
  { name: 'backups', objects: 38, size: '12.1 GB', created: '2026-02-20' },
  { name: 'media-assets', objects: 1024, size: '45.7 GB', created: '2026-03-01' },
];

export const Default: Story = {
  render: () => (
    <Table>
      <Table.Header>
        <Table.Row>
          <Table.Head>Name</Table.Head>
          <Table.Head>Objects</Table.Head>
          <Table.Head>Size</Table.Head>
          <Table.Head>Created</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {sampleData.map((row) => (
          <Table.Row key={row.name}>
            <Table.Cell>{row.name}</Table.Cell>
            <Table.Cell>{row.objects}</Table.Cell>
            <Table.Cell>{row.size}</Table.Cell>
            <Table.Cell>{row.created}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  ),
};

export const WithStickyHeader: Story = {
  render: () => (
    <Table containerStyle={{ maxHeight: 200 }}>
      <Table.Header>
        <Table.Row>
          <Table.Head sticky>Name</Table.Head>
          <Table.Head sticky>Objects</Table.Head>
          <Table.Head sticky>Size</Table.Head>
          <Table.Head sticky>Created</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {[...sampleData, ...sampleData, ...sampleData].map((row, i) => (
          <Table.Row key={i}>
            <Table.Cell>{row.name}</Table.Cell>
            <Table.Cell>{row.objects}</Table.Cell>
            <Table.Cell>{row.size}</Table.Cell>
            <Table.Cell>{row.created}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  ),
};

/** A selectable table with one row already ticked, showing the selected tint. */
export const SelectedRow: Story = {
  render: () => (
    <Table>
      <Table.Header>
        <Table.Row>
          <Table.SelectHead checked={false} onChange={() => {}} label="Select all buckets" />
          <Table.Head>Name</Table.Head>
          <Table.Head>Objects</Table.Head>
          <Table.Head>Size</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {sampleData.map((row, i) => (
          <Table.Row key={row.name} selected={i === 1}>
            <Table.SelectCell checked={i === 1} onChange={() => {}} label={`Select ${row.name}`} />
            <Table.Cell>{row.name}</Table.Cell>
            <Table.Cell>{row.objects}</Table.Cell>
            <Table.Cell>{row.size}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  ),
};

/**
 * Drives the selection interaction end to end: ticking a row's checkbox marks
 * the row selected (via `data-selected`), and unticking clears it.
 */
export const Selection: Story = {
  render: function Render() {
    const [selected, setSelected] = useState<Record<string, boolean>>({});
    const toggle = (name: string) => setSelected((s) => ({ ...s, [name]: !s[name] }));

    return (
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.SelectHead
              checked={sampleData.every((r) => selected[r.name])}
              onChange={() => {
                const allSelected = sampleData.every((r) => selected[r.name]);
                setSelected(Object.fromEntries(sampleData.map((r) => [r.name, !allSelected])));
              }}
              label="Select all buckets"
            />
            <Table.Head>Name</Table.Head>
            <Table.Head>Objects</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {sampleData.map((row) => (
            <Table.Row key={row.name} selected={!!selected[row.name]}>
              <Table.SelectCell
                checked={!!selected[row.name]}
                onChange={() => toggle(row.name)}
                label={`Select ${row.name}`}
              />
              <Table.Cell>{row.name}</Table.Cell>
              <Table.Cell>{row.objects}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rowCheckbox = canvas.getByLabelText('Select backups');
    const row = rowCheckbox.closest('[data-slot="table-row"]')!;

    await expect(row).not.toHaveAttribute('data-selected');

    await userEvent.click(rowCheckbox);
    await expect(row).toHaveAttribute('data-selected');

    await userEvent.click(rowCheckbox);
    await expect(row).not.toHaveAttribute('data-selected');
  },
};

export const Empty: Story = {
  render: () => (
    <Table>
      <Table.Header>
        <Table.Row>
          <Table.Head>Name</Table.Head>
          <Table.Head>Objects</Table.Head>
          <Table.Head>Size</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        <Table.Row className="hover:bg-transparent">
          <Table.Cell colSpan={3} className="py-16 text-center whitespace-normal">
            <div className="flex flex-col items-center gap-3">
              <IconBox icon={FolderOpenIcon} size="md" color="grey" />
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-zinc-900">No data available</p>
                <p className="text-sm text-zinc-500">Add items to see them listed here.</p>
              </div>
            </div>
          </Table.Cell>
        </Table.Row>
      </Table.Body>
    </Table>
  ),
};
