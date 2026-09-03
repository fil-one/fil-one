import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Tabs, TabList, Tab, TabPanels, TabPanel } from '.';

describe('Tabs', () => {
  it('renders tabs and panels', () => {
    render(
      <Tabs>
        <TabList>
          <Tab>Tab 1</Tab>
          <Tab>Tab 2</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>Panel 1</TabPanel>
          <TabPanel>Panel 2</TabPanel>
        </TabPanels>
      </Tabs>,
    );
    expect(screen.getByText('Tab 1')).toBeInTheDocument();
    expect(screen.getByText('Panel 1')).toBeInTheDocument();
  });

  it('switches panels when clicking tabs', () => {
    render(
      <Tabs>
        <TabList>
          <Tab>Tab 1</Tab>
          <Tab>Tab 2</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>Panel 1</TabPanel>
          <TabPanel>Panel 2</TabPanel>
        </TabPanels>
      </Tabs>,
    );
    fireEvent.click(screen.getByText('Tab 2'));
    expect(screen.getByText('Panel 2')).toBeInTheDocument();
  });

  it('renders a count after the label, grouped, and omits it when absent', () => {
    render(
      <Tabs>
        <TabList>
          <Tab count={148213}>Objects</Tab>
          <Tab count={0}>Invitations</Tab>
          <Tab>Billing</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>Panel 1</TabPanel>
          <TabPanel>Panel 2</TabPanel>
          <TabPanel>Panel 3</TabPanel>
        </TabPanels>
      </Tabs>,
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveTextContent('Objects148,213');
    expect(tabs[1]).toHaveTextContent('Invitations0');
    expect(tabs[2]).toHaveTextContent('Billing');
    expect(tabs[2].querySelector('.tab-count')).toBeNull();
  });
});
