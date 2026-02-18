import { createRootRoute, Link, Outlet } from '@tanstack/react-router';

function RootLayout() {
  return (
    <>
      <nav style={{ padding: '1rem', borderBottom: '1px solid #e5e7eb', marginBottom: '2rem' }}>
        <Link to="/" style={{ marginRight: '1rem', textDecoration: 'none', fontWeight: 'bold' }}>
          Hyperspace
        </Link>
        <Link
          to="/upload"
          style={{ textDecoration: 'none', color: '#3b82f6' }}
          activeProps={{ style: { textDecoration: 'none', color: '#1d4ed8', fontWeight: 'bold' } }}
        >
          Upload
        </Link>
      </nav>
      <main style={{ maxWidth: '720px', margin: '0 auto', padding: '0 1rem' }}>
        <Outlet />
      </main>
    </>
  );
}

export const Route = createRootRoute({ component: RootLayout });
