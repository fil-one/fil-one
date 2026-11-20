import { Link } from '@tanstack/react-router';

import { PageLayout } from '../components/PageLayout.js';
import { McpConnectSection } from './McpConnectSection.js';

/**
 * Connecting an AI agent to Fil One over MCP. Every role gets this page, since
 * an agent acts with its user's own role.
 */
export function AgentsPage() {
  return (
    <PageLayout
      title="AI agents"
      description="Connect an AI agent such as Claude, Codex or VS Code to Fil One"
    >
      <div className="flex flex-col gap-6">
        <McpConnectSection />
        <p className="text-sm text-(--color-paragraph-text)">
          To give an agent a scoped key instead, use Connection details in{' '}
          <Link
            to="/api-keys"
            className="rounded-md font-medium text-brand-600 transition-colors hover:text-brand-700 hover:underline focus-visible:brand-outline"
          >
            API keys
          </Link>
          .
        </p>
      </div>
    </PageLayout>
  );
}
