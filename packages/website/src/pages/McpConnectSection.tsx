import { Card } from '../components/Card';
import { CodeBlock } from '../components/CodeBlock';
import { CopyButton } from '../components/CopyButton';
import { Heading } from '../components/Heading/Heading';
import { Tab, TabList, TabPanel, TabPanels, Tabs } from '../components/Tabs';
import { type McpClient, getMcpClientSteps, getMcpServerUrl } from '../lib/mcp-connect.js';
import { Step, StepNote } from './ConnectionDetailsTab.js';

const MCP_CLIENTS: { id: McpClient; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'vscode', label: 'VS Code' },
];

/**
 * Connecting an agent to the console's MCP server: the URL, then each agent's
 * steps. The agent signs the user in through Auth0, so there is no key to hand
 * over, and the server covers the whole org, so no region applies.
 */
export function McpConnectSection() {
  const url = getMcpServerUrl(window.location.origin);
  const steps = getMcpClientSteps(url);

  return (
    <section>
      <Heading tag="h3" size="sm" className="mb-3">
        Connect an agent with MCP
      </Heading>
      <p className="mb-3 text-sm text-(--color-paragraph-text)">
        Your agent signs in with your Fil One account and can do only what your role allows. There
        is no key to copy.
      </p>
      <Card padding="none" className="overflow-hidden">
        <div className="group flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-100 px-4 py-2.5 sm:flex-nowrap sm:py-2">
          <span className="shrink-0 basis-full text-ui text-(--color-paragraph-text-subtle) sm:w-24 sm:basis-auto">
            Server URL
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-(--color-text-base)">
            {url}
          </span>
          <span className="shrink-0 transition pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-within:opacity-100">
            <CopyButton value={url} />
          </span>
        </div>
        <Tabs>
          <TabList className="overflow-x-auto px-2 [scrollbar-width:none]">
            {MCP_CLIENTS.map((client) => (
              <Tab
                key={client.id}
                testId={`mcp-client-${client.id}`}
                className="shrink-0 whitespace-nowrap"
              >
                {client.label}
              </Tab>
            ))}
          </TabList>
          <TabPanels className="mt-0">
            {MCP_CLIENTS.map((client) => (
              <TabPanel key={client.id} className="divide-y divide-zinc-100">
                {steps[client.id].map((step, index) => (
                  <Step key={step.title} n={index + 1} title={step.title}>
                    {step.note && <StepNote>{step.note}</StepNote>}
                    {step.code && <CodeBlock minimal language="shell" code={step.code} />}
                  </Step>
                ))}
              </TabPanel>
            ))}
          </TabPanels>
        </Tabs>
      </Card>
    </section>
  );
}
