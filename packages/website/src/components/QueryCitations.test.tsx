import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import type { QueryBucketResponse } from '@filone/shared';

import {
  QUESTION,
  forgeBucket,
  hybridAnswer,
  timeTravelAnswer,
} from '../lib/rag-engine-fixtures.js';
import { QueryAnswer } from './QueryAnswer';

function renderAnswer(result: QueryBucketResponse) {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryAnswer
        bucket={forgeBucket}
        question={QUESTION}
        isPending={false}
        isError={false}
        error={undefined}
        result={result}
      />
    ),
  });
  const objectsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/buckets/$bucketName/objects',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([objectsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(<RouterProvider router={router} />);
}

describe('QueryAnswer with engine citations', () => {
  it('renders each [n] in the answer as a marker and lists the cited passages', async () => {
    renderAnswer(hybridAnswer);
    const markers = await screen.findAllByTestId('citation-marker');
    expect(markers.map((m) => m.textContent)).toEqual(['1', '2', '3']);
    expect(screen.getByTestId('query-answer-text')).not.toHaveTextContent('[1]');

    const cards = screen.getAllByTestId('citation-card');
    expect(cards).toHaveLength(3);
    expect(within(cards[0]!).getByTestId('citation-object')).toHaveTextContent(
      'data-retention.pdf',
    );
    expect(cards[0]).toHaveTextContent('policies/data-retention.pdf · chunk 7');
    expect(cards[0]).toHaveTextContent('RRF 0.0325');
    expect(cards[0]).toHaveTextContent(/retained for 35 days/);
    // Engine answers replace the plain source pills.
    expect(screen.queryByTestId('query-sources')).not.toBeInTheDocument();
  });

  it('selects the cited passage when its marker is clicked', async () => {
    renderAnswer(hybridAnswer);
    const markers = await screen.findAllByTestId('citation-marker');
    fireEvent.click(markers[1]!);

    expect(markers[1]).toHaveAttribute('aria-pressed', 'true');
    const cards = screen.getAllByTestId('citation-card');
    expect(cards[1]).toHaveAttribute('data-active', 'true');
    expect(cards[0]).not.toHaveAttribute('data-active');
  });

  describe('scrolling the selected passage into view', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    });

    function stubMotionPreference(reduce: boolean) {
      vi.stubGlobal(
        'matchMedia',
        (query: string) =>
          ({ matches: reduce && query === '(prefers-reduced-motion: reduce)' }) as MediaQueryList,
      );
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      return scroll;
    }

    it.each([
      { reduce: false, behavior: 'smooth' },
      { reduce: true, behavior: 'auto' },
    ])(
      'scrolls with behavior $behavior when reduced motion is $reduce',
      async ({ reduce, behavior }) => {
        const scroll = stubMotionPreference(reduce);
        renderAnswer(hybridAnswer);
        fireEvent.click((await screen.findAllByTestId('citation-marker'))[1]!);
        expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest', behavior });
      },
    );
  });

  it('links each citation to the object in the bucket browser', async () => {
    renderAnswer(hybridAnswer);
    const link = (await screen.findAllByTestId('citation-object'))[2]!;
    expect(link.getAttribute('href')).toContain('/buckets/acme-handbook/objects');
    expect(link.getAttribute('href')).toContain('region=eu-central-3');
  });

  it('keeps the paragraph breaks in a multi-paragraph answer', async () => {
    renderAnswer({
      ...hybridAnswer,
      answer: 'Backups are kept for 35 days [1].\n\nA litigation hold overrides that [3].',
    });
    const text = await screen.findByTestId('query-answer-text');
    expect(text).toHaveClass('whitespace-pre-line');
    expect(text.textContent).toContain('.\n\nA litigation hold');
  });

  it('shows how the query was served, including bytes read from Forge', async () => {
    renderAnswer(hybridAnswer);
    const trace = await screen.findByTestId('query-trace');
    expect(within(trace).getByTestId('trace-mode')).toHaveTextContent('Hybrid');
    expect(within(trace).getByTestId('trace-version')).toHaveTextContent('v14');
    expect(within(trace).getByTestId('trace-index')).toHaveTextContent('IVF_HNSW_SQ + FTS');
    expect(within(trace).getByTestId('trace-rows')).toHaveTextContent('1,912');
    expect(within(trace).getByTestId('trace-io')).toHaveTextContent('412.7 KB in 27 requests');
    expect(within(trace).getByTestId('trace-timings')).toHaveTextContent('5.8 s');
    expect(within(trace).getByTestId('trace-timings')).toHaveTextContent('5.9 s');
  });

  it('omits IO when the engine did not measure it, and scores by distance in vector mode', async () => {
    renderAnswer(timeTravelAnswer);
    expect(await screen.findByTestId('query-trace')).not.toHaveTextContent('Read');
    expect(screen.getAllByTestId('citation-card')[0]).toHaveTextContent('Distance 0.182');
  });

  it('says so when no answer was generated but passages were found', async () => {
    renderAnswer({ ...hybridAnswer, answer: '' });
    expect(await screen.findByTestId('query-answer-empty')).toHaveTextContent(
      'No answer was generated in time. These passages matched.',
    );
    expect(screen.queryByTestId('query-answer-text')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('citation-card')).toHaveLength(3);
  });

  it('says nothing matched when there are no citations', async () => {
    renderAnswer({ ...hybridAnswer, answer: '', citations: [], sources: [] });
    expect(await screen.findByTestId('query-answer-empty')).toHaveTextContent(
      'Nothing in this bucket matched',
    );
    expect(screen.queryByTestId('query-citations')).not.toBeInTheDocument();
  });
});
