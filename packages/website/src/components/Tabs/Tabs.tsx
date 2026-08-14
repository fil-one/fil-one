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
  /** Controlled selected index. Pair with {@link onChange} to drive tabs from outside. */
  selectedIndex?: number;
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
  testId?: string;
};

export type TabPanelsProps = {
  children: React.ReactNode;
  className?: string;
};

export type TabPanelProps = {
  children: React.ReactNode;
  className?: string;
  testId?: string;
};

export function Tabs({ children, defaultIndex = 0, selectedIndex, onChange }: TabsProps) {
  // Controlled when `selectedIndex` is supplied; otherwise uncontrolled via `defaultIndex`.
  // Headless UI's TabGroup reads the mode off `selectedIndex` alone (it defaults the prop
  // to null and treats non-null as controlled), so `defaultIndex` is dead weight there.
  const modeProps = selectedIndex === undefined ? { defaultIndex } : { selectedIndex };
  return (
    <TabGroup {...modeProps} onChange={onChange}>
      {children}
    </TabGroup>
  );
}

export function TabList({ children, className }: TabListProps) {
  return <HeadlessTabList className={clsx('tabs-list', className)}>{children}</HeadlessTabList>;
}

export function TabItem({ children, disabled, className, testId }: TabItemProps) {
  return (
    <HeadlessTab disabled={disabled} data-testid={testId} className={clsx('tab-item', className)}>
      {children}
    </HeadlessTab>
  );
}

export function TabPanels({ children, className }: TabPanelsProps) {
  return (
    <HeadlessTabPanels className={clsx('tab-panels', className)}>{children}</HeadlessTabPanels>
  );
}

export function TabPanel({ children, className, testId }: TabPanelProps) {
  return (
    <HeadlessTabPanel data-testid={testId} className={clsx('tab-panel', className)}>
      {children}
    </HeadlessTabPanel>
  );
}
