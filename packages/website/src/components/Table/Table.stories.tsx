import type { Meta, StoryObj } from '@storybook/react-vite';

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
        <Table.Row>
          <Table.Cell colSpan={3} className="text-center text-zinc-500">
            No data available
          </Table.Cell>
        </Table.Row>
      </Table.Body>
    </Table>
  ),
};
