import { Badge } from '../components/Badge.js';
import { CodeBlock } from '../components/CodeBlock.js';
import { Link } from '../components/Link.js';
import { RAG_DOCS_URL } from '../lib/rag-docs.js';
import { buildQueryCurl } from '../lib/rag-query-snippet.js';

// ---------------------------------------------------------------------------
// ApiReference
// ---------------------------------------------------------------------------

/**
 * Display copy for the two Fil-One-managed Bedrock models. Every model is
 * managed: there is no bring-your-own-model or custom-embedding path, so this is
 * reference material for API callers rather than something to configure.
 *
 * Sources of truth: the completion id must match the single entry in
 * `SUPPORTED_COMPLETION_MODELS` (packages/shared/src/api/rag.ts), which is what
 * the `model` request override validates against; the embedding model is
 * `EMBEDDING_MODEL_ID` in @filone/rag-shared. The embedding id is deliberately
 * not shown, because callers cannot select an embedding model.
 */
const MANAGED_MODELS = [
  { role: 'Indexing', name: 'Titan Text Embeddings V2', id: undefined },
  { role: 'Answers', name: 'Claude Opus 4.8', id: 'us.anthropic.claude-opus-4-8' },
] as const;

/**
 * One labelled row of reference material: label in a fixed left column, content
 * on the right. Borrowed from settings-page layouts, and the reason this section
 * no longer needs cards or icons to look organised: alignment does that work, so
 * the keys table above stays the only boxed element on the tab.
 */
function ReferenceRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 py-4 sm:flex-row sm:gap-6">
      {/* No top padding: label and content are both text-xs, so they share a
          baseline only if neither is nudged. */}
      <p className="w-32 flex-shrink-0 text-xs font-medium leading-4 text-zinc-500">{label}</p>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * The non-bucket-specific half of calling the API: the endpoint shape and which
 * models run. Rendered under the API-keys table, because that is where someone
 * goes to get a key and it is reachable with nothing indexed yet.
 *
 * A runnable call for one bucket lives in that bucket's drawer, where the bucket
 * is already chosen. This content briefly had its own "Integrate" tab with a
 * bucket dropdown to pick which bucket the snippet described, which is a filter
 * compensating for page-level placement of bucket-level content; its default
 * ("All buckets") rendered a snippet nobody could run.
 */
export function ApiReference() {
  const endpointShape = buildQueryCurl({ bucketName: '{bucketName}', region: '{region}' });

  return (
    <section data-testid="api-reference" className="pt-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
        Reference
      </h3>
      <div className="mt-1 divide-y divide-zinc-100">
        <ReferenceRow label="Query endpoint">
          <CodeBlock code={endpointShape} language="bash" />
          <p className="mt-2 text-xs text-zinc-500">
            Export your key as <code className="font-mono">FILONE_RAG_KEY</code>, then replace{' '}
            <code className="font-mono">{'{bucketName}'}</code> and{' '}
            <code className="font-mono">{'{region}'}</code>. Opening a bucket gives you the same
            call with those already filled in.
          </p>
        </ReferenceRow>
        <ReferenceRow label="Models">
          <dl data-testid="api-models" className="space-y-1.5">
            {MANAGED_MODELS.map((model) => (
              <div key={model.role} className="flex items-baseline gap-3 text-xs">
                <dt className="w-16 flex-shrink-0 text-zinc-500">{model.role}</dt>
                <dd className="min-w-0 text-zinc-800">
                  <span className="font-medium">{model.name}</span>
                  {model.id && <code className="ml-2 font-mono text-zinc-500">{model.id}</code>}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
            <Badge color="grey" size="sm" strength="subtle">
              Managed
            </Badge>
            Bring-your-own-model support is coming soon.
          </p>
        </ReferenceRow>
        <ReferenceRow label="Documentation">
          <p className="text-xs leading-4 text-zinc-500">
            Supported file types, indexing schedule, and key handling in full.{' '}
            <Link href={RAG_DOCS_URL} variant="accent">
              docs.fil.one
            </Link>
          </p>
        </ReferenceRow>
      </div>
    </section>
  );
}
