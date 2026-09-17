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

export const WithCounts: Story = {
  render: () => (
    <Tabs>
      <TabList>
        <TabItem count={12}>Members</TabItem>
        <TabItem count={0}>Invitations</TabItem>
        <TabItem count={148213}>Objects</TabItem>
        <TabItem>Billing</TabItem>
      </TabList>
      <TabPanels>
        <TabPanel>
          <p className="py-4">A count sits one step back from its label.</p>
        </TabPanel>
        <TabPanel>
          <p className="py-4">A genuine zero shows, because nought is an answer.</p>
        </TabPanel>
        <TabPanel>
          <p className="py-4">Large counts are grouped: 148,213.</p>
        </TabPanel>
        <TabPanel>
          <p className="py-4">A tab with nothing to count carries no number.</p>
        </TabPanel>
      </TabPanels>
    </Tabs>
  ),
};

/** A count is absent until its list answers, so no tab flashes a nought. */
export const CountsLoading: Story = {
  render: () => (
    <Tabs>
      <TabList>
        <TabItem count={undefined}>Members</TabItem>
        <TabItem count={undefined}>Invitations</TabItem>
      </TabList>
      <TabPanels>
        <TabPanel>
          <p className="py-4">Members are still loading.</p>
        </TabPanel>
        <TabPanel>
          <p className="py-4">Invitations are still loading.</p>
        </TabPanel>
      </TabPanels>
    </Tabs>
  ),
};

export const WithDisabledTab: Story = {
  render: () => (
    <Tabs>
      <TabList>
        <TabItem count={4}>Active</TabItem>
        <TabItem disabled count={7}>
          Disabled
        </TabItem>
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
