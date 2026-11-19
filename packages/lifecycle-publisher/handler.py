"""Publish committed, privacy-limited lifecycle outcomes from a durable outbox.

Prebundled Python Lambda: boto3 is supplied by the AWS Python runtime. Never
log stream payloads, SDK error messages, or producer details.
"""
from datetime import datetime, timezone
from functools import lru_cache
import json
import os
import re
import time

import boto3
from boto3.dynamodb.types import TypeDeserializer
from botocore.config import Config

TOKEN = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
DOMAIN = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
REQUIRED = {"schema_version", "event_id", "event_type", "occurred_at", "organization_id"}
PRODUCER_TYPES = {
    "filone.identity": {"organization.signup", "presign.first_issued"},
    "filone.billing": {"trial.started", "payment.succeeded", "payment.failed", "payment.method_added"},
}


def get_source():
    """Retain only reviewed source labels, never arbitrary environment content."""
    source = os.environ.get("LIFECYCLE_SOURCE", "filone.identity")
    return source if source in PRODUCER_TYPES else "unknown"


@lru_cache(maxsize=1)
def get_client():
    """Publish directly into the broker region, independently of platform region."""
    return boto3.client("events", region_name=os.environ["LIFECYCLE_BROKER_REGION"],
                        config=Config(connect_timeout=2, read_timeout=5,
                                      retries={"total_max_attempts": 2}))


def read_detail(image, now=None):
    """Reject corrupted/unexpected outbox rows before putting anything on the bus."""
    row = {key: TypeDeserializer().deserialize(value) for key, value in image.items()}
    detail = row.get("detail")
    kind = detail.get("event_type") if isinstance(detail, dict) else None
    allowed_types = PRODUCER_TYPES.get(get_source(), set())
    extra_fields = ({"email_domain"} if kind == "organization.signup"
                    else {"observed_tenant"} if kind == "presign.first_issued" else set())
    if (not isinstance(detail, dict) or not REQUIRED <= detail.keys()
            or detail.keys() - REQUIRED - extra_fields
            or isinstance(detail.get("schema_version"), bool)
            or detail.get("schema_version") != 1
            or kind not in allowed_types):
        raise ValueError("Invalid lifecycle fields")
    if any(not isinstance(detail.get(key), str) or not TOKEN.fullmatch(detail[key])
           for key in ("event_id", "organization_id")):
        raise ValueError("Invalid lifecycle identity")
    if row.get("event_id") != detail["event_id"]:
        raise ValueError("Mismatched lifecycle identity")
    if kind == "presign.first_issued":
        tenant = detail.get("observed_tenant")
        if (not isinstance(tenant, dict) or set(tenant) != {"sp", "id"}
                or any(not isinstance(tenant[key], str) or not TOKEN.fullmatch(tenant[key])
                       for key in ("sp", "id"))):
            raise ValueError("Invalid observed tenant mapping")
    occurred = datetime.fromisoformat(detail["occurred_at"].replace("Z", "+00:00"))
    now = now or datetime.now(timezone.utc)
    if occurred.tzinfo is None or not -300 <= (now - occurred).total_seconds() < 180 * 86400:
        raise ValueError("Lifecycle timestamp outside delivery window")
    domain = detail.get("email_domain")
    if domain is not None and (not isinstance(domain, str) or len(domain) > 253
                               or not DOMAIN.fullmatch(domain)):
        raise ValueError("Invalid lifecycle domain")
    # DynamoDB numbers deserialize to Decimal; the accepted version is an int
    # in the downstream JSON contract, not a quoted decimal.
    return {**detail, "schema_version": 1}


def handler(event, context):
    """Report failed sequences; checkpoint retries can redeliver later successes."""
    failures = []
    records = event.get("Records", [])
    for record in records:
        if record.get("eventName") != "INSERT":
            continue  # TTL deletes and record maintenance are never new outcomes.
        sequence = record["dynamodb"]["SequenceNumber"]
        try:
            detail = read_detail(record["dynamodb"]["NewImage"])
            response = get_client().put_events(Entries=[{
                "EventBusName": os.environ["LIFECYCLE_BUS_ARN"],
                "Source": get_source(),
                "DetailType": "filone.lifecycle.v1",
                "Detail": json.dumps(detail, separators=(",", ":")),
            }])
            # PutEvents can return HTTP 200 while a specific entry failed.
            entries = response.get("Entries", [])
            if (response.get("FailedEntryCount", 0) or len(entries) != 1
                    or not entries[0].get("EventId") or entries[0].get("ErrorCode")):
                raise RuntimeError("Lifecycle delivery was not accepted")
        except Exception:
            failures.append({"itemIdentifier": sequence})
    # Embedded metrics contain aggregate outcomes only, never the failed
    # record, Organization identifier, exception text or source address.
    print(json.dumps({
        "_aws": {"Timestamp": int(time.time() * 1000), "CloudWatchMetrics": [{
            "Namespace": "FilOne/Lifecycle", "Dimensions": [["Stage", "Producer"]],
            "Metrics": [{"Name": "PublishFailures", "Unit": "Count"}],
        }]},
        "Stage": os.environ.get("FILONE_STAGE", "unknown"),
        "Producer": get_source(),
        "PublishFailures": len(failures),
    }))
    return {"batchItemFailures": failures}
