# @hyperspace/website

## Local Development

Run the website locally against any deployed backend (staging, personal dev stack, etc.).

### Prerequisites

- Node.js 24+
- pnpm

### 1. Configure environment variables

Copy `.env.local` and set `DEV_PROXY_TARGET` to the backend you want to develop against:

```env
# Leave empty — the Vite proxy handles routing /api/* to the backend
VITE_API_URL=

# Point to any deployed stack
DEV_PROXY_TARGET=https://staging.filhyperspace.com

VITE_S3_ENDPOINT=https://s3.hyperspace.filecoin.io
VITE_AUTH0_DOMAIN=dev-oar2nhqh58xf5pwf.us.auth0.com
VITE_AUTH0_CLIENT_ID=hAHMVzFTsFMrtxHDfzOvQCLHgaAf3bPQ
VITE_AUTH0_AUDIENCE=console.filhyperspace.com
```

| Variable               | Purpose                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `VITE_API_URL`         | Must be empty for local dev. The Vite proxy serves `/api/*` so cookies stay on localhost. |
| `DEV_PROXY_TARGET`     | The backend URL that Vite proxies `/api/*` requests to.                                   |
| `VITE_S3_ENDPOINT`     | S3-compatible endpoint shown in Connection Details UI.                                    |
| `VITE_AUTH0_DOMAIN`    | Auth0 tenant domain. Use the dev value which allows localhost/dev stages.                 |
| `VITE_AUTH0_CLIENT_ID` | Auth0 SPA application client ID - use dev value (above).                                  |
| `VITE_AUTH0_AUDIENCE`  | Auth0 API audience identifier - use dev value (above).                                    |

### 2. Start the dev server

```bash
pnpm run dev
```

Vite starts at **https://localhost:5173**. You will need to accept the self-signed certificate on first visit (the `@vitejs/plugin-basic-ssl` plugin generates it automatically).

### How it works

The dev server runs over HTTPS so that `Secure` auth cookies work on localhost. A Vite proxy forwards all `/api/*` requests to the `DEV_PROXY_TARGET` backend, keeping cookies on the same origin. The proxy also injects an `X-Dev-Origin` header so the backend knows to redirect back to localhost after login/logout instead of the deployed site URL.

### Switching backends

Change `DEV_PROXY_TARGET` in `.env.local` and restart the dev server (eg):

```env
# Personal dev stack
DEV_PROXY_TARGET=https://d1abc2def3.cloudfront.net

# Staging
DEV_PROXY_TARGET=https://staging.filhyperspace.com
```
