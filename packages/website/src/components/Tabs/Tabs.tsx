import {
  Tab as HeadlessTab,
  TabGroup,
  TabList as HeadlessTabList,
  TabPanel as HeadlessTabPanel,
  TabPanels as HeadlessTabPanels,
} from '@headlessui/react';
import { clsx } from 'clsx';

export type TabsProps = {
  children: React.ReactNode;
  defaultIndex?: number;
  onChange?: (index: number) => void;
};

export type TabListProps = {
  children: React.ReactNode;
  className?: string;
};

export type TabItemProps = {
  children: React.ReactNode;
  disabled?: boolean;
  className?: string;
};

export type TabPanelsProps = {
  children: React.ReactNode;
  className?: string;
};

export type TabPanelProps = {
  children: React.ReactNode;
  className?: string;
};

export function Tabs({ children, defaultIndex = 0, onChange }: TabsProps) {
  return (
    <TabGroup defaultIndex={defaultIndex} onChange={onChange}>
      {children}
    </TabGroup>
  );
}

export function TabList({ children, className }: TabListProps) {
  return <HeadlessTabList className={clsx('tabs-list', className)}>{children}</HeadlessTabList>;
}

export function TabItem({ children, disabled, className }: TabItemProps) {
  return (
    <HeadlessTab disabled={disabled} className={clsx('tab-item', className)}>
      {children}
    </HeadlessTab>
  );
}

export function TabPanels({ children, className }: TabPanelsProps) {
  return (
    <HeadlessTabPanels className={clsx('tab-panels', className)}>{children}</HeadlessTabPanels>
  );
}

export function TabPanel({ children, className }: TabPanelProps) {
  return <HeadlessTabPanel className={clsx('tab-panel', className)}>{children}</HeadlessTabPanel>;
}
