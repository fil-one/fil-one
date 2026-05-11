"""
Aurora Portal & Back Office API: Access Key Management

This tool talks to two different Aurora APIs:

  • Portal API      — tenant-scoped operations (env, access keys).
                      Auth: per-tenant API key cached at ~/.aurora_token.
  • Back Office API — partner-scoped operations (list tenants).
                      Auth: partner-level API key passed via env/CLI.

The per-tenant key is provisioned during tenant creation and stored in AWS
SSM. The `login` command fetches it from SSM and caches it locally.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
USAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # Step 1 — fetch tenant API key from SSM and cache it
  python tools/aurora_key_management.py login \\
    --stage dev --region eu-west-1 --tenant-id <TENANT_ID>

  # Step 2 — discover env (Portal API)
  python tools/aurora_key_management.py env \\
    --portal-origin https://api.portal.dev.aur.lu --no-verify

  # Step 3 — list tenants (Back Office API; uses partner-level key)
  python tools/aurora_key_management.py tenants \\
    --backoffice-origin https://api.backoffice.dev.aur.lu \\
    --backoffice-api-key <PARTNER_API_KEY> --no-verify

  # Step 4 — list access keys for a tenant (Portal API)
  python tools/aurora_key_management.py keys \\
    --portal-origin https://api.portal.dev.aur.lu \\
    --tenant <TENANT_ID> --no-verify

  # Step 5 — create a key
  python tools/aurora_key_management.py create-key \\
    --portal-origin https://api.portal.dev.aur.lu --tenant <TENANT_ID> \\
    --name "compat-test-full" --access '["s3:*"]' --no-verify

  # Step 6 — delete a key
  python tools/aurora_key_management.py delete-key \\
    --portal-origin https://api.portal.dev.aur.lu --tenant <TENANT_ID> \\
    --key-id <KEY_ID> --no-verify

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ENVIRONMENT VARIABLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  AURORA_PORTAL_ORIGIN       Portal API base URL
  AURORA_BACKOFFICE_ORIGIN   Back Office API base URL
  AURORA_BACKOFFICE_API_KEY  Back Office partner-level API key
  AURORA_TENANT_ID           Default tenant ID for Portal commands

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NOTES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  - Both APIs use the X-Api-Key header.
  - Tokens are cached in ~/.aurora_token (chmod 600) and never printed.
  - The Back Office `tenants` command auto-discovers the partner ID via
    GET /v1/partner before listing tenants under that partner.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import requests
import urllib3

TOKEN_CACHE = Path.home() / ".aurora_token"
API_BASE = "/api/v1"

_VERIFY_SSL = True


# ── HTTP helpers ────────────────────────────────────────────────────────

def _api_url(origin: str, path: str) -> str:
    return f"{origin.rstrip('/')}{API_BASE}{path}"


def _req_kwargs() -> dict:
    return {"verify": _VERIFY_SSL}


def _print_json(data) -> None:
    print(json.dumps(data, indent=2))


# ── Portal token (~/.aurora_token) ──────────────────────────────────────

def _load_portal_token() -> str | None:
    if not TOKEN_CACHE.exists():
        return None
    data = json.loads(TOKEN_CACHE.read_text())
    if "expires_at" in data and time.time() > data["expires_at"]:
        print("Cached Portal token expired. Run `login` again.", file=sys.stderr)
        return None
    return data.get("access_token") or None


def _save_portal_token(token: str, expires_in: int | None = None) -> None:
    payload: dict = {"access_token": token}
    if expires_in is not None:
        payload["expires_at"] = time.time() + expires_in
    TOKEN_CACHE.write_text(json.dumps(payload, indent=2))
    try:
        os.chmod(TOKEN_CACHE, 0o600)
    except OSError:
        pass


def _portal_headers() -> dict:
    token = _load_portal_token()
    if not token:
        print("ERROR: No Portal token cached. Run `login` first.", file=sys.stderr)
        sys.exit(1)
    return {"X-Api-Key": token, "Content-Type": "application/json"}


def _portal_origin(arg_origin: str | None) -> str:
    origin = arg_origin or os.environ.get("AURORA_PORTAL_ORIGIN", "")
    if not origin:
        print("ERROR: --portal-origin or AURORA_PORTAL_ORIGIN required.",
              file=sys.stderr)
        sys.exit(1)
    return origin


# ── Back Office credentials ─────────────────────────────────────────────

def _backoffice_origin(arg_origin: str | None) -> str:
    origin = arg_origin or os.environ.get("AURORA_BACKOFFICE_ORIGIN", "")
    if not origin:
        print("ERROR: --backoffice-origin or AURORA_BACKOFFICE_ORIGIN required.",
              file=sys.stderr)
        sys.exit(1)
    return origin


def _backoffice_headers(arg_key: str | None) -> dict:
    key = arg_key or os.environ.get("AURORA_BACKOFFICE_API_KEY", "")
    if not key:
        print("ERROR: --backoffice-api-key or AURORA_BACKOFFICE_API_KEY required.",
              file=sys.stderr)
        sys.exit(1)
    return {"X-Api-Key": key, "Content-Type": "application/json"}


# ── login: fetch tenant API key from AWS SSM ────────────────────────────

def cmd_login(stage: str, tenant_id: str, region: str, **_) -> None:
    """Fetch the tenant's Portal API key from AWS SSM and cache it."""
    param_name = f"/filone/{stage}/aurora-portal/tenant-api-key/{tenant_id}"
    cmd = [
        "aws", "ssm", "get-parameter",
        "--name", param_name,
        "--region", region,
        "--with-decryption",
        "--query", "Parameter.Value",
        "--output", "text",
    ]
    print(f"Fetching tenant API key from SSM: {param_name} (region={region})")
    try:
        proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
    except FileNotFoundError:
        print("ERROR: 'aws' CLI not found on PATH.", file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError as exc:
        print("ERROR: SSM lookup failed.", file=sys.stderr)
        if exc.stderr:
            print(exc.stderr.strip(), file=sys.stderr)
        sys.exit(1)

    token = proc.stdout.strip()
    if not token or token == "None":
        print("ERROR: SSM returned an empty value.", file=sys.stderr)
        sys.exit(1)

    _save_portal_token(token)
    print(f"Token cached at {TOKEN_CACHE} (chmod 600).")


# ── env (Portal, no auth) ───────────────────────────────────────────────

def cmd_env(portal_origin: str | None = None, **_) -> None:
    origin = _portal_origin(portal_origin)
    url = _api_url(origin, "/environment")
    print(f"GET {url}\n")
    resp = requests.get(url, **_req_kwargs())
    resp.raise_for_status()
    _print_json(resp.json())


# ── tenants (Back Office) ───────────────────────────────────────────────

def _backoffice_partner_id(origin: str, headers: dict) -> str:
    url = _api_url(origin, "/partner")
    resp = requests.get(url, headers=headers, **_req_kwargs())
    resp.raise_for_status()
    return (resp.json() or {}).get("id", "")


def cmd_tenants(backoffice_origin: str | None = None,
                backoffice_api_key: str | None = None, **_) -> None:
    """List tenants for the authenticated partner via the Back Office API."""
    origin = _backoffice_origin(backoffice_origin)
    headers = _backoffice_headers(backoffice_api_key)

    partner_id = _backoffice_partner_id(origin, headers)
    if not partner_id:
        print("ERROR: Couldn't resolve partner ID from /v1/partner.", file=sys.stderr)
        sys.exit(1)

    url = _api_url(origin, f"/partners/{partner_id}/tenants")
    print(f"GET {url}\n")

    items: list = []
    page = 1
    page_size = 100
    while True:
        resp = requests.get(url, headers=headers,
                            params={"page": page, "pageSize": page_size},
                            **_req_kwargs())
        resp.raise_for_status()
        data = resp.json() or {}
        batch = data.get("items") or []
        items.extend(batch)
        total = data.get("totalCount", len(items))
        if not batch or len(items) >= total:
            break
        page += 1

    if not items:
        print("No tenants found.")
        return
    for t in items:
        print(f"  {t['id']}  {t.get('name', '(unnamed)')}  "
              f"status={t.get('status', '?')}  region={t.get('regionName', '?')}")


# ── access keys (Portal) ────────────────────────────────────────────────

def _resolve_tenant(tenant: str | None) -> str:
    if tenant:
        return tenant
    tid = os.environ.get("AURORA_TENANT_ID", "")
    if tid:
        return tid
    print("ERROR: --tenant or AURORA_TENANT_ID required.", file=sys.stderr)
    sys.exit(1)


def cmd_keys(portal_origin: str | None = None,
             tenant: str | None = None, **_) -> None:
    origin = _portal_origin(portal_origin)
    tenant = _resolve_tenant(tenant)
    url = _api_url(origin, f"/tenants/{tenant}/access_keys")
    print(f"GET {url}\n")

    items: list = []
    page = 1
    page_size = 100
    while True:
        resp = requests.get(url, headers=_portal_headers(),
                            params={"page": page, "pageSize": page_size},
                            **_req_kwargs())
        resp.raise_for_status()
        data = resp.json() or {}
        batch = data.get("items") or []
        items.extend(batch)
        total = data.get("totalCount", len(items))
        if not batch or len(items) >= total:
            break
        page += 1

    if not items:
        print("No access keys found.")
        return
    for k in items:
        print(f"  ID: {k.get('id', 'N/A')}")
        print(f"    Name    : {k.get('name', 'N/A')}")
        print(f"    Created : {k.get('createdAt', 'N/A')}")
        print(f"    Expires : {k.get('expiresAt', 'N/A')}")
        print()


def cmd_get_key(key_id: str, portal_origin: str | None = None,
                tenant: str | None = None, **_) -> None:
    origin = _portal_origin(portal_origin)
    tenant = _resolve_tenant(tenant)
    url = _api_url(origin, f"/tenants/{tenant}/access_keys/{key_id}")
    print(f"GET {url}\n")
    resp = requests.get(url, headers=_portal_headers(), **_req_kwargs())
    resp.raise_for_status()
    _print_json(resp.json())


def cmd_create_key(name: str, access: str | None, buckets: str | None,
                   expiration: str | None, portal_origin: str | None = None,
                   tenant: str | None = None, **_) -> None:
    origin = _portal_origin(portal_origin)
    tenant = _resolve_tenant(tenant)
    url = _api_url(origin, f"/tenants/{tenant}/access_keys")

    body: dict = {"name": name}
    if access:
        body["access"] = json.loads(access)
    if buckets:
        body["buckets"] = json.loads(buckets)
    if expiration:
        body["expiration"] = expiration

    print(f"POST {url}")
    print(f"Body: {json.dumps(body, indent=2)}\n")
    resp = requests.post(url, headers=_portal_headers(), json=body, **_req_kwargs())
    resp.raise_for_status()
    data = resp.json()

    ak = data.get("accessKey", data)
    print("Access key created.\n")
    print(f"  Access Key ID     : {ak.get('accessKeyId', 'N/A')}")
    print(f"  Secret Access Key : {ak.get('accessKeySecret', 'N/A')}")
    print(f"  Name              : {ak.get('name', 'N/A')}")
    print(f"  Expires           : {ak.get('expiresAt', 'N/A')}")
    print()
    print("  ** Save the secret now — it won't be shown again. **")


def cmd_delete_key(key_id: str, portal_origin: str | None = None,
                   tenant: str | None = None, **_) -> None:
    origin = _portal_origin(portal_origin)
    tenant = _resolve_tenant(tenant)
    url = _api_url(origin, f"/tenants/{tenant}/access_keys/{key_id}")
    print(f"DELETE {url}\n")
    resp = requests.delete(url, headers=_portal_headers(), **_req_kwargs())
    if resp.status_code == 204:
        print("Access key deleted.")
    else:
        resp.raise_for_status()


# ── CLI ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Aurora Portal & Back Office API: Access Key Management",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--no-verify", action="store_true",
                        help="Disable SSL certificate verification "
                             "(for self-signed dev certs).")

    sub = parser.add_subparsers(dest="command", required=True)

    def _add_portal(p):
        p.add_argument("--portal-origin",
                       help="Portal API base URL "
                            "(or set AURORA_PORTAL_ORIGIN).")

    def _add_tenant(p):
        p.add_argument("--tenant",
                       help="Tenant ID (or set AURORA_TENANT_ID).")

    # env
    p_env = sub.add_parser("env", help="Fetch portal /environment config")
    _add_portal(p_env)

    # login (SSM)
    p_login = sub.add_parser(
        "login",
        help="Fetch tenant API key from AWS SSM and cache it",
    )
    p_login.add_argument("--stage", required=True,
                         help="Deployment stage (e.g. dev, staging, prod)")
    p_login.add_argument("--tenant-id", required=True,
                         help="Tenant ID whose key to fetch")
    p_login.add_argument("--region", required=True,
                         help="AWS region containing the SSM parameter")

    # tenants (Back Office)
    p_tenants = sub.add_parser(
        "tenants",
        help="List tenants for the authenticated partner (Back Office API)",
    )
    p_tenants.add_argument("--backoffice-origin",
                           help="Back Office API base URL "
                                "(or AURORA_BACKOFFICE_ORIGIN).")
    p_tenants.add_argument("--backoffice-api-key",
                           help="Back Office partner-level API key "
                                "(or AURORA_BACKOFFICE_API_KEY).")

    # keys
    p_keys = sub.add_parser("keys", help="List access keys (Portal API)")
    _add_portal(p_keys)
    _add_tenant(p_keys)

    # get-key
    p_get = sub.add_parser("get-key", help="Get access key details (Portal API)")
    _add_portal(p_get)
    _add_tenant(p_get)
    p_get.add_argument("--key-id", required=True, help="Access key ID")

    # create-key
    p_create = sub.add_parser("create-key",
                              help="Create a new access key (Portal API)")
    _add_portal(p_create)
    _add_tenant(p_create)
    p_create.add_argument("--name", required=True, help="Key name")
    p_create.add_argument(
        "--access",
        help='JSON array of permission strings, e.g. \'["s3:*"]\' '
             'or \'["s3:ListBuckets","s3:PutObject"]\'',
    )
    p_create.add_argument(
        "--buckets",
        help='JSON array of bucket names to scope the key to, '
             'e.g. \'["my-bucket"]\'',
    )
    p_create.add_argument("--expiration",
                          help="Expiration timestamp (e.g. 2026-12-31T00:00:00Z)")

    # delete-key
    p_del = sub.add_parser("delete-key",
                           help="Delete an access key (Portal API)")
    _add_portal(p_del)
    _add_tenant(p_del)
    p_del.add_argument("--key-id", required=True, help="Access key ID")

    args = parser.parse_args()

    global _VERIFY_SSL
    if args.no_verify:
        _VERIFY_SSL = False
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    dispatch = {
        "env": lambda: cmd_env(portal_origin=args.portal_origin),
        "login": lambda: cmd_login(stage=args.stage, tenant_id=args.tenant_id,
                                   region=args.region),
        "tenants": lambda: cmd_tenants(
            backoffice_origin=args.backoffice_origin,
            backoffice_api_key=args.backoffice_api_key,
        ),
        "keys": lambda: cmd_keys(portal_origin=args.portal_origin,
                                 tenant=args.tenant),
        "get-key": lambda: cmd_get_key(args.key_id,
                                       portal_origin=args.portal_origin,
                                       tenant=args.tenant),
        "create-key": lambda: cmd_create_key(
            args.name, args.access, args.buckets, args.expiration,
            portal_origin=args.portal_origin, tenant=args.tenant,
        ),
        "delete-key": lambda: cmd_delete_key(args.key_id,
                                             portal_origin=args.portal_origin,
                                             tenant=args.tenant),
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
