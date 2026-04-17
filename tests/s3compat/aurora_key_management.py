"""
Aurora Portal API: Access Key Management

Manage S3 access keys via the Aurora Portal API. Useful when bucket/key
operations are not exposed in the UI and you need to set specific
permissions on access keys (e.g. ListBuckets, CreateBucket).

The Portal API uses Auth0 Bearer tokens. This script can:
  1. Fetch Auth0 config from the /environment endpoint
  2. Cache a Bearer token (paste from browser devtools)
  3. List tenants, list keys, inspect a key, create a key, delete a key

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
USAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # Step 1: Discover Auth0 settings from the portal
  python aurora_key_management.py --origin https://backoffice.dev.aur.lu --no-verify env

  # Step 2: Log in (paste Bearer token from browser devtools)
  python aurora_key_management.py login

  # Step 3: List tenants
  python aurora_key_management.py --origin https://backoffice.dev.aur.lu --no-verify tenants

  # Step 4: List access keys for a tenant
  python aurora_key_management.py --origin https://backoffice.dev.aur.lu --no-verify keys --tenant <TENANT_ID>

  # Step 5: Get details for a specific key
  python aurora_key_management.py --origin https://backoffice.dev.aur.lu --no-verify get-key --tenant <TENANT_ID> --key-id <KEY_ID>

  # Step 6: Create a new key with full S3 permissions
  python aurora_key_management.py --origin https://backoffice.dev.aur.lu --no-verify create-key --tenant <TENANT_ID> --name "compat-test-full" --access '["s3:*"]'

  # Step 7: Delete a key
  python aurora_key_management.py --origin https://backoffice.dev.aur.lu --no-verify delete-key --tenant <TENANT_ID> --key-id <KEY_ID>

  # Tip: to get the Bearer token, open the Aurora backoffice in Chrome,
  # open DevTools (F12) → Network tab → perform any action → click a
  # request to the API → Headers → copy the Authorization header value.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NOTES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  - The --origin flag sets the base URL of the Aurora Portal API
    (e.g. https://portal.dev.aur.lu, https://portal.aur.lu)
  - The access key's `access` field controls S3 permissions but the
    valid values are not documented in the spec. Try broad values like
    ["s3:*"] or ["*"], or ask the Aurora team for the enum.
  - Bearer tokens are cached in ~/.aurora_token for convenience.
    Run `login` again if your token expires.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import requests
import urllib3

TOKEN_CACHE = Path.home() / ".aurora_token"
# base path defined in the Aurora spec
API_BASE = "/api/v1"

# Set to True by --no-verify; disables SSL cert validation for self-signed certs
_VERIFY_SSL = True


# ── helpers ──────────────────────────────────────────────────────────────

def _api_url(origin: str, path: str) -> str:
    return f"{origin.rstrip('/')}{API_BASE}{path}"


def _req_kwargs() -> dict:
    """Common kwargs for requests calls (SSL verification)."""
    return {"verify": _VERIFY_SSL}


def _load_token() -> str | None:
    if TOKEN_CACHE.exists():
        data = json.loads(TOKEN_CACHE.read_text())
        # Check if token has an expiry we stored
        if "expires_at" in data and time.time() > data["expires_at"]:
            print("Cached token expired. Run `login` again.")
            return None
        return data.get("access_token")
    return None


def _save_token(token_data: dict):
    to_store = {"access_token": token_data["access_token"]}
    if "expires_in" in token_data:
        to_store["expires_at"] = time.time() + token_data["expires_in"]
    TOKEN_CACHE.write_text(json.dumps(to_store, indent=2))
    print(f"Token cached at {TOKEN_CACHE}")


def _headers() -> dict:
    token = _load_token()
    if not token:
        print("ERROR: No valid token found. Run `login` first.", file=sys.stderr)
        sys.exit(1)
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _print_json(data):
    print(json.dumps(data, indent=2))


# ── Auth0 environment discovery ─────────────────────────────────────────

def cmd_env(origin: str, **_):
    """Fetch Auth0 config from the portal /environment endpoint."""
    url = _api_url(origin, "/environment")
    print(f"GET {url}\n")
    resp = requests.get(url, **_req_kwargs())
    resp.raise_for_status()
    data = resp.json()
    _print_json(data)
    return data


# ── Login (paste Bearer token) ───────────────────────────────────────────

def cmd_login(token: str | None = None, token_file: str | None = None, **_):
    """Cache a Bearer token obtained from the browser.

    Grab the token from the browser devtools:
      Network tab → any authenticated API request → Authorization header
      → copy the value after "Bearer ".
    """
    if token_file:
        token = Path(token_file).read_text().strip()
    elif not token:
        print("Paste your Bearer token, then press Enter:")
        sys.stdout.flush()
        token = input().strip()

    # Strip "Bearer " prefix if the user copied the full header value
    if token.lower().startswith("bearer "):
        token = token[7:].strip()

    if not token:
        print("ERROR: Empty token.", file=sys.stderr)
        sys.exit(1)

    # Warn about non-ASCII characters (valid JWTs are pure ASCII)
    bad_chars = [(i, c) for i, c in enumerate(token) if ord(c) > 127]
    if bad_chars:
        print(f"WARNING: Token has {len(bad_chars)} non-ASCII character(s):")
        for pos, ch in bad_chars[:5]:
            print(f"  position {pos}: {repr(ch)} (U+{ord(ch):04X})")
        print("This may cause HTTP errors. Try --token-file to avoid shell issues.")

    _save_token({"access_token": token})
    print("Token saved.")


# ── Tenant commands ──────────────────────────────────────────────────────

def _resolve_tenant(origin: str, tenant: str | None) -> str:
    """Return the tenant ID, auto-discovering it if not provided.

    If there's exactly one tenant, uses it automatically.
    If there are multiple, prints them and exits so the user can pick.
    """
    if tenant:
        return tenant

    url = _api_url(origin, "/tenants")
    resp = requests.get(url, headers=_headers(), **_req_kwargs())
    resp.raise_for_status()
    tenants = resp.json().get("tenants", [])

    if not tenants:
        print("ERROR: No tenants found for this account.", file=sys.stderr)
        sys.exit(1)

    if len(tenants) == 1:
        tid = tenants[0]["id"]
        print(f"Using tenant: {tid} ({tenants[0].get('name', '')})\n")
        return tid

    print("Multiple tenants found — pass --tenant <ID> to pick one:\n")
    for t in tenants:
        print(f"  {t['id']}  {t.get('name', '(unnamed)')}")
    sys.exit(1)


def cmd_tenants(origin: str, **_):
    """List tenants for the authenticated organization."""
    url = _api_url(origin, "/tenants")
    print(f"GET {url}\n")
    resp = requests.get(url, headers=_headers(), **_req_kwargs())
    resp.raise_for_status()
    data = resp.json()
    tenants = data.get("tenants", [])
    if not tenants:
        print("No tenants found.")
        return
    for t in tenants:
        print(f"  {t['id']}  {t.get('name', '(unnamed)')}")


# ── Access Key commands ──────────────────────────────────────────────────

def cmd_keys(origin: str, tenant: str | None = None, **_):
    """List access keys for a tenant."""
    tenant = _resolve_tenant(origin, tenant)
    url = _api_url(origin, f"/tenants/{tenant}/access_keys")
    print(f"GET {url}\n")
    resp = requests.get(url, headers=_headers(), **_req_kwargs())
    resp.raise_for_status()
    data = resp.json()
    keys = data.get("accessKeys", [])
    if not keys:
        print("No access keys found.")
        return
    for k in keys:
        print(f"  ID: {k.get('id', 'N/A')}")
        print(f"    Name       : {k.get('name', 'N/A')}")
        print(f"    Created    : {k.get('createdAt', 'N/A')}")
        print(f"    Expires    : {k.get('expiresAt', 'N/A')}")
        print()


def cmd_get_key(origin: str, key_id: str, tenant: str | None = None, **_):
    """Get details for a specific access key."""
    tenant = _resolve_tenant(origin, tenant)
    url = _api_url(origin, f"/tenants/{tenant}/access_keys/{key_id}")
    print(f"GET {url}\n")
    resp = requests.get(url, headers=_headers(), **_req_kwargs())
    resp.raise_for_status()
    _print_json(resp.json())


def cmd_create_key(origin: str, name: str, access: str | None,
                   buckets: str | None, expiration: str | None,
                   tenant: str | None = None, **_):
    """Create a new access key with specified permissions."""
    tenant = _resolve_tenant(origin, tenant)
    url = _api_url(origin, f"/tenants/{tenant}/access_keys")

    body: dict = {"name": name}
    if access:
        body["access"] = json.loads(access)
    if buckets:
        body["buckets"] = json.loads(buckets)
    if expiration:
        body["expiration"] = expiration

    print(f"PUT {url}")
    print(f"Body: {json.dumps(body, indent=2)}\n")
    resp = requests.put(url, headers=_headers(), json=body, **_req_kwargs())
    resp.raise_for_status()
    data = resp.json()

    ak = data.get("accessKey", data)
    print("Access key created successfully!\n")
    print(f"  Access Key ID     : {ak.get('accessKeyId', 'N/A')}")
    print(f"  Secret Access Key : {ak.get('accessKeySecret', 'N/A')}")
    print(f"  Name              : {ak.get('name', 'N/A')}")
    print(f"  Expires           : {ak.get('expiresAt', 'N/A')}")
    print()
    print("  ** Save the secret now — it won't be shown again. **")

    # Show the full response for inspection
    print(f"\nFull response:")
    _print_json(data)


def cmd_delete_key(origin: str, key_id: str, tenant: str | None = None, **_):
    """Delete an access key."""
    tenant = _resolve_tenant(origin, tenant)
    url = _api_url(origin, f"/tenants/{tenant}/access_keys/{key_id}")
    print(f"DELETE {url}\n")
    resp = requests.delete(url, headers=_headers(), **_req_kwargs())
    if resp.status_code == 204:
        print("Access key deleted.")
    else:
        resp.raise_for_status()


# ── CLI ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Aurora Portal API: Access Key Management",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--origin", required=True,
        help="Aurora Portal base URL (e.g. https://portal.dev.aur.lu)",
    )
    parser.add_argument(
        "--no-verify", action="store_true",
        help="Disable SSL certificate verification (for self-signed certs on dev)",
    )

    sub = parser.add_subparsers(dest="command", required=True)

    # env
    sub.add_parser("env", help="Fetch Auth0/environment config from the portal")

    # login
    p_login = sub.add_parser("login", help="Cache a Bearer token from the browser")
    p_login.add_argument("--token", help="Bearer token (or omit to paste interactively)")
    p_login.add_argument("--token-file", help="Read Bearer token from a file")

    # tenants
    sub.add_parser("tenants", help="List tenants")

    # keys
    p_keys = sub.add_parser("keys", help="List access keys")
    p_keys.add_argument("--tenant", help="Tenant ID (auto-detected if only one)")

    # get-key
    p_get = sub.add_parser("get-key", help="Get access key details")
    p_get.add_argument("--tenant", help="Tenant ID (auto-detected if only one)")
    p_get.add_argument("--key-id", required=True, help="Access key ID")

    # create-key
    p_create = sub.add_parser("create-key", help="Create a new access key")
    p_create.add_argument("--tenant", help="Tenant ID (auto-detected if only one)")
    p_create.add_argument("--name", required=True, help="Key name")
    p_create.add_argument(
        "--access",
        help='JSON array of permission strings, e.g. \'["s3:*"]\' or \'["s3:ListBuckets","s3:PutObject"]\'',
    )
    p_create.add_argument(
        "--buckets",
        help='JSON array of bucket names to scope the key to, e.g. \'["my-bucket"]\'',
    )
    p_create.add_argument("--expiration", help="Expiration timestamp (e.g. 2026-12-31T00:00:00Z)")

    # delete-key
    p_del = sub.add_parser("delete-key", help="Delete an access key")
    p_del.add_argument("--tenant", help="Tenant ID (auto-detected if only one)")
    p_del.add_argument("--key-id", required=True, help="Access key ID")

    args = parser.parse_args()

    global _VERIFY_SSL
    if args.no_verify:
        _VERIFY_SSL = False
        # Suppress the noisy "InsecureRequestWarning" on every call
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    dispatch = {
        "env": lambda: cmd_env(args.origin),
        "login": lambda: cmd_login(
            token=getattr(args, "token", None),
            token_file=getattr(args, "token_file", None),
        ),
        "tenants": lambda: cmd_tenants(args.origin),
        "keys": lambda: cmd_keys(args.origin, tenant=getattr(args, "tenant", None)),
        "get-key": lambda: cmd_get_key(args.origin, args.key_id, tenant=getattr(args, "tenant", None)),
        "create-key": lambda: cmd_create_key(
            args.origin, args.name,
            args.access, args.buckets, args.expiration,
            tenant=getattr(args, "tenant", None),
        ),
        "delete-key": lambda: cmd_delete_key(args.origin, args.key_id, tenant=getattr(args, "tenant", None)),
    }

    try:
        dispatch[args.command]()
    except requests.HTTPError as e:
        print(f"\nHTTP Error {e.response.status_code}:", file=sys.stderr)
        try:
            _print_json(e.response.json())
        except Exception:
            print(e.response.text, file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nAborted.")
        sys.exit(130)


if __name__ == "__main__":
    main()