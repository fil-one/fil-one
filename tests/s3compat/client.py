import os
import sys
from pathlib import Path

import boto3
from botocore import UNSIGNED
from botocore.client import Config
from dotenv import load_dotenv


def resolve_provider(name: str) -> Path:
    """Validate a provider name and load its .env. Returns the provider directory."""
    provider_dir = Path(__file__).parent / name
    if not provider_dir.is_dir():
        print(f"ERROR: Provider directory not found: {provider_dir}", file=sys.stderr)
        sys.exit(1)
    env_file = provider_dir / ".env"
    if not env_file.exists():
        print(f"ERROR: No .env file found at {env_file}", file=sys.stderr)
        sys.exit(1)
    load_dotenv(env_file, override=True)
    return provider_dir


def get_s3_client():
    session = boto3.session.Session(
        aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
        region_name="us-east-1",
    )
    return session.client(
        "s3",
        endpoint_url=os.environ.get("S3_ENDPOINT"),
    )


def get_source_client():
    """Anonymous boto3 client pointed at source.coop (public datasets)."""
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("SOURCE_ENDPOINT", "https://data.source.coop"),
        config=Config(signature_version=UNSIGNED),
        region_name="us-east-1",
    )
