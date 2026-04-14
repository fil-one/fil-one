import type { Meta, StoryObj } from '@storybook/react-vite';

import { TabItem, TabList, TabPanel, TabPanels, Tabs } from './Tabs';

const meta: Meta<typeof Tabs> = {
  title: 'Components/Tabs',
  component: Tabs,
};

export default meta;
type Story = StoryObj<typeof Tabs>;

export const Default: Story = {
  render: () => (
    <Tabs>
      <TabList>
        <TabItem>Overview</TabItem>
        <TabItem>Objects</TabItem>
        <TabItem>Settings</TabItem>
      </TabList>
      <TabPanels>
        <TabPanel>
          <p className="py-4">Overview content goes here.</p>
        </TabPanel>
        <TabPanel>
          <p className="py-4">Objects list goes here.</p>
        </TabPanel>
        <TabPanel>
          <p className="py-4">Settings form goes here.</p>
        </TabPanel>
      </TabPanels>
    </Tabs>
  ),
};

export const WithDefaultIndex: Story = {
  render: () => (
    <Tabs defaultIndex={1}>
      <TabList>
        <TabItem>Tab 1</TabItem>
        <TabItem>Tab 2</TabItem>
        <TabItem>Tab 3</TabItem>
      </TabList>
      <TabPanels>
        <TabPanel>
          <p className="py-4">First panel</p>
        </TabPanel>
        <TabPanel>
          <p className="py-4">Second panel (default selected)</p>
        </TabPanel>
        <TabPanel>
          <p className="py-4">Third panel</p>
        </TabPanel>
      </TabPanels>
    </Tabs>
  ),
};

export const WithDisabledTab: Story = {
  render: () => (
    <Tabs>
      <TabList>
        <TabItem>Active</TabItem>
        <TabItem disabled>Disabled</TabItem>
        <TabItem>Also active</TabItem>
      </TabList>
      <TabPanels>
        <TabPanel>
          <p className="py-4">First panel content</p>
        </TabPanel>
        <TabPanel>
          <p className="py-4">This panel is unreachable</p>
        </TabPanel>
        <TabPanel>
          <p className="py-4">Third panel content</p>
        </TabPanel>
      </TabPanels>
    </Tabs>
  ),
};
