import { createRoute } from '@tanstack/react-router';
import { Route as rootRoute } from './__root.js';

function HomePage() {
  return (
    <div>
      <h1>Hyperspace</h1>
      <p>
        Hyperspace is a prototype for decentralised file storage on Filecoin via AWS.
      </p>
      <p>
        Use the <a href="/upload">Upload</a> page to submit a file for storage.
      </p>
    </div>
  );
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
});
