import os

import boto3
from botocore import UNSIGNED
from botocore.client import Config
from dotenv import load_dotenv

load_dotenv()


def get_aurora_client():
    session = boto3.session.Session(
        aws_access_key_id=os.environ["AURORA_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AURORA_SECRET_ACCESS_KEY"],
        region_name="us-east-1",
    )
    return session.client(
        "s3",
        endpoint_url=os.environ.get("AURORA_ENDPOINT", "https://a-s3.aur.lu"),
    )


def get_source_client():
    """Anonymous boto3 client pointed at source.coop (public datasets)."""
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("SOURCE_ENDPOINT", "https://data.source.coop"),
        config=Config(signature_version=UNSIGNED),
        region_name="us-east-1",
    )