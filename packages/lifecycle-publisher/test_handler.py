"""Offline producer contract and transport retry checks; no AWS writes."""
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
from unittest.mock import Mock

import pytest
from boto3.dynamodb.types import TypeSerializer

spec = importlib.util.spec_from_file_location("lifecycle_publisher", Path(__file__).with_name("handler.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


def image(**changes):
    detail = {"schema_version": 1, "event_id": "signup_any-org",
              "event_type": "organization.signup", "organization_id": "any-org",
              "occurred_at": datetime.now(timezone.utc).isoformat(),
              **({"email_domain": "example.org"}
                 if changes.get("event_type", "organization.signup") == "organization.signup" else {}),
              **changes}
    row = {"event_id": detail["event_id"], "detail": detail, "expires_at": 9999999999}
    return {key: TypeSerializer().serialize(value) for key, value in row.items()}


def record(number="1", **changes):
    return {"eventName": "INSERT", "dynamodb": {"SequenceNumber": number,
                                                 "NewImage": image(**changes)}}


@pytest.fixture
def client(monkeypatch):
    client = Mock()
    client.put_events.return_value = {"FailedEntryCount": 0, "Entries": [{"EventId": "any-id"}]}
    monkeypatch.setattr(publisher, "get_client", lambda: client)
    monkeypatch.setenv("LIFECYCLE_BUS_ARN", "arn:aws:events:us-east-1:654654381893:event-bus/s3-auditbroker-lifecycle")
    return client


def test_publishes_only_contract_fields_and_preserves_identity_across_retry(client):
    event = {"Records": [record()]}
    assert publisher.handler(event, None) == {"batchItemFailures": []}
    first = client.put_events.call_args.kwargs
    assert publisher.handler(event, None) == {"batchItemFailures": []}
    assert client.put_events.call_args.kwargs == first
    entry = first["Entries"][0]
    assert entry["Source"] == "filone.identity"
    assert json.loads(entry["Detail"]) == publisher.read_detail(event["Records"][0]["dynamodb"]["NewImage"])


def test_putevents_partial_failure_returns_only_failed_sequence(client):
    client.put_events.side_effect = [
        {"FailedEntryCount": 1, "Entries": [{"ErrorCode": "AccessDeniedException"}]},
        {"FailedEntryCount": 0, "Entries": [{"EventId": "accepted"}]},
    ]
    assert publisher.handler({"Records": [record("1"), record("2")]}, None) == {
        "batchItemFailures": [{"itemIdentifier": "1"}]}


def test_sdk_exception_is_retryable_with_only_aggregate_metrics(client, capsys):
    client.put_events.side_effect = RuntimeError("secret-context")
    assert publisher.handler({"Records": [record()]}, None) == {
        "batchItemFailures": [{"itemIdentifier": "1"}]}
    captured = capsys.readouterr()
    metric = json.loads(captured.out)
    assert metric["PublishFailures"] == 1
    assert "secret-context" not in captured.out
    assert "any-org" not in captured.out
    assert captured.err == ""


@pytest.mark.parametrize("fields", [
    {"email": "private@example.org"}, {"event_type": "restriction.applied"},
    {"organization_id": "private@example.org"}, {"email_domain": "private@example.org"},
])
def test_rejects_unauthorized_or_private_metadata_before_delivery(client, fields):
    assert publisher.handler({"Records": [record(**fields)]}, None) == {
        "batchItemFailures": [{"itemIdentifier": "1"}]}
    client.put_events.assert_not_called()


def test_ignores_ttl_removals_and_modified_rows(client):
    assert publisher.handler({"Records": [{"eventName": "REMOVE"}, {"eventName": "MODIFY"}]}, None) == {
        "batchItemFailures": []}
    client.put_events.assert_not_called()


def test_publishes_first_presign_with_only_opaque_verified_tenant_mapping(client):
    event = {"Records": [record(event_type="presign.first_issued",
                                observed_tenant={"sp": "aurora", "id": "any-tenant"})]}
    assert publisher.handler(event, None) == {"batchItemFailures": []}
    detail = json.loads(client.put_events.call_args.kwargs["Entries"][0]["Detail"])
    assert detail["observed_tenant"] == {"sp": "aurora", "id": "any-tenant"}
    assert set(detail) == publisher.REQUIRED | {"observed_tenant"}


@pytest.mark.parametrize("mapping", [None, {"sp": "aurora"},
                                     {"sp": "aurora", "id": "private@example.org"},
                                     {"sp": "aurora", "id": "any-tenant", "key": "secret"}])
def test_refuses_first_presign_without_a_valid_exact_mapping(client, mapping):
    assert publisher.handler({"Records": [record(event_type="presign.first_issued",
                                                  observed_tenant=mapping)]}, None) == {
        "batchItemFailures": [{"itemIdentifier": "1"}]}
    client.put_events.assert_not_called()


@pytest.mark.parametrize("kind", ["trial.started", "payment.succeeded", "payment.failed", "payment.method_added"])
def test_billing_role_emits_only_its_fixed_source_and_outcome_contract(client, monkeypatch, kind):
    monkeypatch.setenv("LIFECYCLE_SOURCE", "filone.billing")
    assert publisher.handler({"Records": [record(event_type=kind)]}, None) == {"batchItemFailures": []}
    entry = client.put_events.call_args.kwargs["Entries"][0]
    assert entry["Source"] == "filone.billing"
    assert set(json.loads(entry["Detail"])) == publisher.REQUIRED


@pytest.mark.parametrize("source,kind", [
    ("filone.identity", "trial.started"),
    ("filone.identity", "payment.succeeded"),
    ("filone.identity", "payment.method_added"),
    ("filone.billing", "organization.signup"),
    ("filone.billing", "presign.first_issued"),
])
def test_distinct_producer_authorities_cannot_impersonate_each_other(client, monkeypatch, source, kind):
    monkeypatch.setenv("LIFECYCLE_SOURCE", source)
    assert publisher.handler({"Records": [record(event_type=kind)]}, None) == {
        "batchItemFailures": [{"itemIdentifier": "1"}]}
    client.put_events.assert_not_called()


def test_unrecognized_source_is_rejected_and_never_copied_to_metrics(client, monkeypatch, capsys):
    monkeypatch.setenv("LIFECYCLE_SOURCE", "private-misconfigured-value")
    assert publisher.handler({"Records": [record()]}, None) == {
        "batchItemFailures": [{"itemIdentifier": "1"}]}
    client.put_events.assert_not_called()
    output = capsys.readouterr().out
    assert "private-misconfigured-value" not in output
    assert json.loads(output)["Producer"] == "unknown"
