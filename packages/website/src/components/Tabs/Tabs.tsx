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
  /**
   * The selected tab, when the caller drives the selection. Pass `onChange`
   * alongside it — a controlled group cannot change tab on its own, so without
   * one the tabs stop responding to clicks. Leave both out for the ordinary
   * case, where the group tracks its own selection from `defaultIndex`.
   */
  selectedIndex?: number;
  onChange?: (index: number) => void;
};

export type TabListProps = {
  children: React.ReactNode;
  className?: string;
};

export type TabItemProps = {
  children: React.ReactNode;
  /**
   * How many things the tab's panel holds, shown after the label.
   *
   * Optional rather than defaulting to zero: a tab whose list has not answered
   * yet passes `undefined` and renders no number, so it never flashes a nought
   * on the way to its real count. A genuine zero still shows, because "0" is an
   * answer.
   */
  count?: number;
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
  // `defaultIndex` is left off entirely when controlled: Headless UI treats
  // passing both as a conflict.
  return selectedIndex === undefined ? (
    <TabGroup defaultIndex={defaultIndex} onChange={onChange}>
      {children}
    </TabGroup>
  ) : (
    <TabGroup selectedIndex={selectedIndex} onChange={onChange}>
      {children}
    </TabGroup>
  );
}

export function TabList({ children, className }: TabListProps) {
  return <HeadlessTabList className={clsx('tabs-list', className)}>{children}</HeadlessTabList>;
}

export function TabItem({ children, count, disabled, className, testId }: TabItemProps) {
  return (
    <HeadlessTab disabled={disabled} data-testid={testId} className={clsx('tab-item', className)}>
      {children}
      {count !== undefined && <span className="tab-count">{count.toLocaleString()}</span>}
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
