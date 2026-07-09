# S3 Compatibility Test — fth

| Field  | Value                |
| ------ | -------------------- |
| Script | `compatibility_test` |
| Run    | `20260708_122448`    |

## Summary

| Total |  OK | Failed | Status   |
| ----: | --: | -----: | :------- |
|   598 | 415 |    183 | **FAIL** |

## BY CATEGORY

| Category               | Pass rate         |  OK | Failed | Total |     Avg |  Stddev |    Min |      Max |
| ---------------------- | :---------------- | --: | -----: | ----: | ------: | ------: | -----: | -------: |
| `bucket_logging`       | **0%** (0/6)      |   0 |      6 |     6 |  2.836s |  0.383s | 2.345s |   3.505s |
| `bucket_policy`        | **50%** (6/12)    |   6 |      6 |    12 |  2.977s |  1.320s | 2.201s |   7.116s |
| `checksum`             | **91%** (10/11)   |  10 |      1 |    11 |  7.966s |  5.829s | 2.843s |  22.867s |
| `conditional_write`    | **43%** (3/7)     |   3 |      4 |     7 |  4.833s |  2.881s | 2.132s |  11.136s |
| `copy`                 | **68%** (21/31)   |  21 |     10 |    31 |  4.879s |  4.310s | 1.811s |  17.041s |
| `delete_marker`        | **100%** (3/3)    |   3 |      0 |     3 |  2.598s |  0.230s | 2.326s |   2.889s |
| `encryption`           | **58%** (63/108)  |  63 |     45 |   108 |  4.043s |  5.717s | 1.338s |  52.421s |
| `lifecycle`            | **93%** (14/15)   |  14 |      1 |    15 |  1.930s |  0.125s | 1.772s |   2.277s |
| `lifecycle_expiration` | **100%** (6/6)    |   6 |      0 |     6 | 12.525s | 22.559s | 2.282s |  62.967s |
| `list_objects_v2`      | **85%** (40/47)   |  40 |      7 |    47 |  2.693s |  0.813s | 1.270s |   7.037s |
| `s3_core`              | **70%** (228/324) | 228 |     96 |   324 |  5.411s | 14.204s | 1.229s | 142.081s |
| `sse_s3`               | **33%** (1/3)     |   1 |      2 |     3 |  1.819s |  0.065s | 1.767s |   1.911s |
| `tagging`              | **80%** (20/25)   |  20 |      5 |    25 |  2.850s |  0.451s | 2.157s |   4.184s |

## Run details

```
TEST RUN
  Provider  : fth
  Collected : 838
  Passed    : 415
  Failed    : 181
  Error     : 2
  Skipped   : 5
  Duration  : 2947.4s
  Marks     : not fails_on_aws
  Filter    : (none)
  Passes    : main (not (object_lock)), quarantine (object_lock)
  Target    : s3tests/functional/test_s3.py
  Raw JSON  : ../logs/20260708_122448_compatibility_pytest_main.json, ../logs/20260708_122448_compatibility_pytest_quarantine.json
```

## Errors

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_basic_key_count</summary>

**Test description**

> ListObjectsV2 returns KeyCount equal to the number of objects in the bucket (5).

**Error stack trace** — `list_objects_v2` — `failed` — 7.037s

```pytb
s3tests/functional/test_s3.py:203: in test_basic_key_count
    client.put_object(Bucket=bucket_name, Key=str(j))
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_listv2_encoding_basic</summary>

**Test description**

> ListObjectsV2 with EncodingType=url URL-encodes special characters (`+` → `%2B`, ` ` → `%20`) in both keys and CommonPrefixes.

**Error stack trace** — `list_objects_v2` — `failed` — 1.856s

```pytb
s3tests/functional/test_s3.py:238: in test_bucket_listv2_encoding_basic
    bucket_name = _create_objects(keys=['foo+1/bar', 'foo/bar/xyzzy', 'quux ab/thud', 'asdf+b'])
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:137: in _create_objects
    obj = bucket.put_object(Body=key, Key=key, **put_object_args)
          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/factory.py:581: in do_action
    response = action(self, *args, **kwargs)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/action.py:88: in __call__
    response = getattr(parent.meta.client, operation_name)(*args, **params)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the PutObject operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_list_encoding_basic</summary>

**Test description**

> ListObjects with EncodingType=url URL-encodes special characters in keys and CommonPrefixes.

**Error stack trace** — `s3_core` — `failed` — 1.957s

```pytb
s3tests/functional/test_s3.py:251: in test_bucket_list_encoding_basic
    bucket_name = _create_objects(keys=['foo+1/bar', 'foo/bar/xyzzy', 'quux ab/thud', 'asdf+b'])
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:137: in _create_objects
    obj = bucket.put_object(Body=key, Key=key, **put_object_args)
          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/factory.py:581: in do_action
    response = action(self, *args, **kwargs)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/action.py:88: in __call__
    response = getattr(parent.meta.client, operation_name)(*args, **params)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the PutObject operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_list_delimiter_percentage</summary>

**Test description**

> Delimiter `%`; keys with `%` collapse into CommonPrefixes.

**Error stack trace** — `s3_core` — `failed` — 1.818s

```pytb
s3tests/functional/test_s3.py:444: in test_bucket_list_delimiter_percentage
    bucket_name = _create_objects(keys=['b%ar', 'b%az', 'c%ab', 'foo'])
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:137: in _create_objects
    obj = bucket.put_object(Body=key, Key=key, **put_object_args)
          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/factory.py:581: in do_action
    response = action(self, *args, **kwargs)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/action.py:88: in __call__
    response = getattr(parent.meta.client, operation_name)(*args, **params)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the PutObject operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_listv2_delimiter_percentage</summary>

**Test description**

> Delimiter `%`; keys with `%` collapse, others (foo) stay in Contents.

**Error stack trace** — `list_objects_v2` — `failed` — 1.851s

```pytb
s3tests/functional/test_s3.py:460: in test_bucket_listv2_delimiter_percentage
    bucket_name = _create_objects(keys=['b%ar', 'b%az', 'c%ab', 'foo'])
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:137: in _create_objects
    obj = bucket.put_object(Body=key, Key=key, **put_object_args)
          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/factory.py:581: in do_action
    response = action(self, *args, **kwargs)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/action.py:88: in __call__
    response = getattr(parent.meta.client, operation_name)(*args, **params)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the PutObject operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_list_delimiter_whitespace</summary>

**Test description**

> Delimiter ` ` (space); keys with spaces collapse.

**Error stack trace** — `s3_core` — `failed` — 1.777s

```pytb
s3tests/functional/test_s3.py:475: in test_bucket_list_delimiter_whitespace
    bucket_name = _create_objects(keys=['b ar', 'b az', 'c ab', 'foo'])
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:137: in _create_objects
    obj = bucket.put_object(Body=key, Key=key, **put_object_args)
          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/factory.py:581: in do_action
    response = action(self, *args, **kwargs)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/action.py:88: in __call__
    response = getattr(parent.meta.client, operation_name)(*args, **params)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the PutObject operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_listv2_delimiter_whitespace</summary>

**Test description**

> Delimiter ` ` (space); keys with spaces collapse into CommonPrefixes.

**Error stack trace** — `list_objects_v2` — `failed` — 1.73s

```pytb
s3tests/functional/test_s3.py:491: in test_bucket_listv2_delimiter_whitespace
    bucket_name = _create_objects(keys=['b ar', 'b az', 'c ab', 'foo'])
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:137: in _create_objects
    obj = bucket.put_object(Body=key, Key=key, **put_object_args)
          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/factory.py:581: in do_action
    response = action(self, *args, **kwargs)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/action.py:88: in __call__
    response = getattr(parent.meta.client, operation_name)(*args, **params)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the PutObject operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_list_delimiter_not_skip_special</summary>

**Test description**

> Special character handling in delimiter that should not skip valid keys.

**Error stack trace** — `s3_core` — `failed` — 142.081s

```pytb
s3tests/functional/test_s3.py:686: in test_bucket_list_delimiter_not_skip_special
    bucket_name = _create_objects(keys=key_names)
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:137: in _create_objects
    obj = bucket.put_object(Body=key, Key=key, **put_object_args)
          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/factory.py:581: in do_action
    response = action(self, *args, **kwargs)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/action.py:88: in __call__
    response = getattr(parent.meta.client, operation_name)(*args, **params)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the PutObject operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_head_zero_bytes</summary>

**Test description**

> HeadObject on a 0-byte object returns ContentLength=0.

**Error stack trace** — `s3_core` — `failed` — 7.336s

```pytb
s3tests/functional/test_s3.py:1798: in test_object_head_zero_bytes
    client.put_object(Bucket=bucket_name, Key='foo', Body='')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_set_get_metadata_none_to_empty</summary>

**Test description**

> PutObject sets an empty user-metadata value; GetObject returns the empty string.

**Error stack trace** — `s3_core` — `failed` — 1.856s

```pytb
s3tests/functional/test_s3.py:1878: in test_object_set_get_metadata_none_to_empty
    got = _set_get_metadata('')
          ^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:1868: in _set_get_metadata
    client.put_object(Bucket=bucket_name, Key='foo', Body='bar', Metadata=metadata_dict)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the PutObject operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_set_get_metadata_overwrite_to_empty</summary>

**Test description**

> PutObject overwriting an object replaces metadata; new empty value sticks.

**Error stack trace** — `s3_core` — `failed` — 2.54s

```pytb
s3tests/functional/test_s3.py:1885: in test_object_set_get_metadata_overwrite_to_empty
    got = _set_get_metadata('', bucket_name)
          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:1868: in _set_get_metadata
    client.put_object(Bucket=bucket_name, Key='foo', Body='bar', Metadata=metadata_dict)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the PutObject operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_post_object_escaped_field_values</summary>

**Test description**

> Escaped characters in policy condition values are accepted.

**Error stack trace** — `s3_core` — `failed` — 2.312s

```pytb
s3tests/functional/test_s3.py:2278: in test_post_object_escaped_field_values
    response = client.get_object(Bucket=bucket_name, Key=r'\$foo.txt')
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the GetObject operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_get_object_ifnonematch_good</summary>

**Test description**

> GetObject with If-None-Match=<wrong-etag> succeeds.

**Error stack trace** — `s3_core` — `failed` — 2.151s

```pytb
s3tests/functional/test_s3.py:3054: in test_get_object_ifnonematch_good
    assert e.response['ResponseMetadata']['HTTPHeaders']['etag'] == etag
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
E   KeyError: 'etag'
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_get_object_ifnonematch_failed</summary>

**Test description**

> GetObject with If-None-Match=<correct-etag> expects 304 NotModified.

**Error stack trace** — `s3_core` — `failed` — 2.208s

```pytb
s3tests/functional/test_s3.py:3061: in test_get_object_ifnonematch_failed
    response = client.get_object(Bucket=bucket_name, Key='foo', IfNoneMatch='ABCORZ')
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InvalidArgument) when calling the GetObject operation: Invalid request headers
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_get_object_ifmodifiedsince_failed</summary>

**Test description**

> GetObject with If-Modified-Since after mtime expects 304 NotModified.

**Error stack trace** — `s3_core` — `failed` — 3.446s

```pytb
s3tests/functional/test_s3.py:3095: in test_get_object_ifmodifiedsince_failed
    assert e.response['ResponseMetadata']['HTTPHeaders']['etag'] == etag
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
E   KeyError: 'etag'
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_get</summary>

**Test description**

> Unauthenticated GET via raw HTTP on a public-read object succeeds.

**Error stack trace** — `s3_core` — `failed` — 6.056s

```pytb
s3tests/functional/test_s3.py:3298: in test_object_raw_get
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read')
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_get_bucket_gone</summary>

**Test description**

> Raw GET after the bucket was deleted expects 404 NoSuchBucket.

**Error stack trace** — `s3_core` — `failed` — 9.006s

```pytb
s3tests/functional/test_s3.py:3305: in test_object_raw_get_bucket_gone
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read')
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_delete_key_bucket_gone</summary>

**Test description**

> DeleteObject after the bucket was deleted expects 404 NoSuchBucket.

**Error stack trace** — `s3_core` — `failed` — 9.099s

```pytb
s3tests/functional/test_s3.py:3319: in test_object_delete_key_bucket_gone
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read')
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_get_object_gone</summary>

**Test description**

> Raw GET on a deleted object expects 404 NoSuchKey.

**Error stack trace** — `s3_core` — `failed` — 9.198s

```pytb
s3tests/functional/test_s3.py:3333: in test_object_raw_get_object_gone
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read')
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_get_bucket_acl</summary>

**Test description**

> Raw GET on a private bucket (no policy) expects 403.

**Error stack trace** — `s3_core` — `failed` — 5.34s

```pytb
s3tests/functional/test_s3.py:3386: in test_object_raw_get_bucket_acl
    bucket_name = _setup_bucket_object_acl('private', 'public-read')
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_get_object_acl</summary>

**Test description**

> Raw GET on a private object expects 403.

**Error stack trace** — `s3_core` — `failed` — 11.668s

```pytb
s3tests/functional/test_s3.py:3393: in test_object_raw_get_object_acl
    bucket_name = _setup_bucket_object_acl('public-read', 'private')
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_authenticated</summary>

**Test description**

> Signed (authenticated) raw GET succeeds even on a private object.

**Error stack trace** — `s3_core` — `failed` — 8.16s

```pytb
s3tests/functional/test_s3.py:3439: in test_object_raw_authenticated
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read')
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_response_headers</summary>

**Test description**

> GetObject query-string response-header overrides (response-content-type, etc.) override the response headers.

**Error stack trace** — `s3_core` — `failed` — 9.923s

```pytb
s3tests/functional/test_s3.py:3446: in test_object_raw_response_headers
    bucket_name = _setup_bucket_object_acl('private', 'private')
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_authenticated_bucket_acl</summary>

**Test description**

> Authenticated GET on a private bucket succeeds for the owner.

**Error stack trace** — `s3_core` — `failed` — 7.715s

```pytb
s3tests/functional/test_s3.py:3459: in test_object_raw_authenticated_bucket_acl
    bucket_name = _setup_bucket_object_acl('private', 'public-read')
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_authenticated_object_acl</summary>

**Test description**

> Authenticated GET on a private object succeeds for the owner.

**Error stack trace** — `s3_core` — `failed` — 11.474s

```pytb
s3tests/functional/test_s3.py:3466: in test_object_raw_authenticated_object_acl
    bucket_name = _setup_bucket_object_acl('public-read', 'private')
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_authenticated_bucket_gone</summary>

**Test description**

> Authenticated GET after the bucket was deleted expects 404.

**Error stack trace** — `s3_core` — `failed` — 6.124s

```pytb
s3tests/functional/test_s3.py:3473: in test_object_raw_authenticated_bucket_gone
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read')
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_authenticated_object_gone</summary>

**Test description**

> Authenticated GET on a deleted object expects 404.

**Error stack trace** — `s3_core` — `failed` — 9.035s

```pytb
s3tests/functional/test_s3.py:3485: in test_object_raw_authenticated_object_gone
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read')
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_get_x_amz_expires_not_expired</summary>

**Test description**

> Presigned URL with X-Amz-Expires in the future succeeds.

**Error stack trace** — `s3_core` — `failed` — 11.604s

```pytb
s3tests/functional/test_s3.py:3508: in test_object_raw_get_x_amz_expires_not_expired
    _test_object_raw_get_x_amz_expires_not_expired(client=get_client())
s3tests/functional/test_s3.py:3496: in _test_object_raw_get_x_amz_expires_not_expired
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read', client=client)
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_get_x_amz_expires_not_expired_tenant</summary>

**Test description**

> Tenant-scoped presigned URL with valid expiration succeeds.

**Error stack trace** — `s3_core` — `failed` — 13.615s

```pytb
s3tests/functional/test_s3.py:3511: in test_object_raw_get_x_amz_expires_not_expired_tenant
    _test_object_raw_get_x_amz_expires_not_expired(client=get_tenant_client())
s3tests/functional/test_s3.py:3496: in _test_object_raw_get_x_amz_expires_not_expired
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read', client=client)
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_get_x_amz_expires_out_range_zero</summary>

**Test description**

> Presigned URL with X-Amz-Expires=0 expects 400 (out of valid range).

**Error stack trace** — `s3_core` — `failed` — 5.5s

```pytb
s3tests/functional/test_s3.py:3514: in test_object_raw_get_x_amz_expires_out_range_zero
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read')
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_get_x_amz_expires_out_max_range</summary>

**Test description**

> Presigned URL with X-Amz-Expires beyond the 7-day max expects 400.

**Error stack trace** — `s3_core` — `failed` — 13.694s

```pytb
s3tests/functional/test_s3.py:3524: in test_object_raw_get_x_amz_expires_out_max_range
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read')
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_get_x_amz_expires_out_positive_range</summary>

**Test description**

> Same boundary check at a still-out-of-range positive value.

**Error stack trace** — `s3_core` — `failed` — 7.17s

```pytb
s3tests/functional/test_s3.py:3534: in test_object_raw_get_x_amz_expires_out_positive_range
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read')
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_content_encoding_aws_chunked</summary>

**Test description**

> PutObject with Content-Encoding=aws-chunked; body parses correctly and roundtrips.

**Error stack trace** — `s3_core` — `failed` — 8.012s

```pytb
s3tests/functional/test_s3.py:3548: in test_object_content_encoding_aws_chunked
    client.put_object(Bucket=bucket, Key=key, ContentEncoding='gzip')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_anon_put</summary>

**Test description**

> Anonymous PutObject on a private bucket expects 403.

**Error stack trace** — `s3_core` — `failed` — 13.062s

```pytb
s3tests/functional/test_s3.py:3576: in test_object_anon_put
    client.put_object(Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_anon_put_write_access</summary>

**Test description**

> Anonymous PutObject after PutBucketAcl=public-read-write succeeds.

**Error stack trace** — `s3_core` — `failed` — 8.124s

```pytb
s3tests/functional/test_s3.py:3588: in test_object_anon_put_write_access
    client.put_object(Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_raw_put_authenticated_expired</summary>

**Test description**

> Presigned PUT after expiry expects 403.

**Error stack trace** — `s3_core` — `failed` — 10.45s

```pytb
s3tests/functional/test_s3.py:3635: in test_object_raw_put_authenticated_expired
    client.put_object(Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_acl_default</summary>

**Test description**

> GetBucketAcl on a freshly created bucket; expects a single FULL_CONTROL grant to the bucket owner.

**Error stack trace** — `s3_core` — `failed` — 1.881s

```pytb
s3tests/functional/test_s3.py:3946: in test_bucket_acl_default
    assert response['Owner']['DisplayName'] == display_name
E   AssertionError: assert 'admin' == 'Your Name'
E
E     [0m[91m- Your Name[39;49;00m[90m[39;49;00m
E     [92m+ admin[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_acl_canned</summary>

**Test description**

> PutBucketAcl with canned ACL public-read; GetBucketAcl reflects the public-read grant.

**Error stack trace** — `s3_core` — `failed` — 1.633s

```pytb
s3tests/functional/test_s3.py:4007: in test_bucket_acl_canned
    check_grants(
s3tests/functional/test_s3.py:3929: in check_grants
    assert g['Grantee'].pop('DisplayName', None) == w['DisplayName']
E   AssertionError: assert '186' == 'Your Name'
E
E     [0m[91m- Your Name[39;49;00m[90m[39;49;00m
E     [92m+ 186[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_acl_canned_publicreadwrite</summary>

**Test description**

> PutBucketAcl public-read-write applies READ + WRITE grants to AllUsers.

**Error stack trace** — `s3_core` — `failed` — 1.993s

```pytb
s3tests/functional/test_s3.py:4056: in test_bucket_acl_canned_publicreadwrite
    check_grants(
s3tests/functional/test_s3.py:3929: in check_grants
    assert g['Grantee'].pop('DisplayName', None) == w['DisplayName']
E   AssertionError: assert '186' == 'Your Name'
E
E     [0m[91m- Your Name[39;49;00m[90m[39;49;00m
E     [92m+ 186[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_acl_canned_authenticatedread</summary>

**Test description**

> PutBucketAcl authenticated-read applies READ to AuthenticatedUsers group.

**Error stack trace** — `s3_core` — `failed` — 1.899s

```pytb
s3tests/functional/test_s3.py:4096: in test_bucket_acl_canned_authenticatedread
    check_grants(
s3tests/functional/test_s3.py:3929: in check_grants
    assert g['Grantee'].pop('DisplayName', None) == w['DisplayName']
E   AssertionError: assert '186' == 'Your Name'
E
E     [0m[91m- Your Name[39;49;00m[90m[39;49;00m
E     [92m+ 186[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_put_bucket_acl_grant_group_read</summary>

**Test description**

> PutBucketAcl with a Group grantee for READ permission; GetBucketAcl reflects it.

**Error stack trace** — `s3_core` — `failed` — 2.031s

```pytb
s3tests/functional/test_s3.py:4131: in test_put_bucket_acl_grant_group_read
    check_grants(
s3tests/functional/test_s3.py:3929: in check_grants
    assert g['Grantee'].pop('DisplayName', None) == w['DisplayName']
E   AssertionError: assert '186' == 'Your Name'
E
E     [0m[91m- Your Name[39;49;00m[90m[39;49;00m
E     [92m+ 186[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_acl_default</summary>

**Test description**

> New objects have a single FULL_CONTROL grant to the bucket owner.

**Error stack trace** — `s3_core` — `failed` — 2.165s

```pytb
s3tests/functional/test_s3.py:4165: in test_object_acl_default
    check_grants(
s3tests/functional/test_s3.py:3929: in check_grants
    assert g['Grantee'].pop('DisplayName', None) == w['DisplayName']
E   AssertionError: assert '186' == 'Your Name'
E
E     [0m[91m- Your Name[39;49;00m[90m[39;49;00m
E     [92m+ 186[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_acl_canned_during_create</summary>

**Test description**

> PutObject with ACL=public-read sets that canned ACL on creation.

**Error stack trace** — `s3_core` — `failed` — 1.992s

```pytb
s3tests/functional/test_s3.py:4191: in test_object_acl_canned_during_create
    check_grants(
s3tests/functional/test_s3.py:3929: in check_grants
    assert g['Grantee'].pop('DisplayName', None) == w['DisplayName']
E   AssertionError: assert '186' == 'Your Name'
E
E     [0m[91m- Your Name[39;49;00m[90m[39;49;00m
E     [92m+ 186[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_acl_canned</summary>

**Test description**

> PutObjectAcl with canned public-read; GetObjectAcl reflects the new grant.

**Error stack trace** — `s3_core` — `failed` — 2.072s

```pytb
s3tests/functional/test_s3.py:4225: in test_object_acl_canned
    check_grants(
s3tests/functional/test_s3.py:3929: in check_grants
    assert g['Grantee'].pop('DisplayName', None) == w['DisplayName']
E   AssertionError: assert '186' == 'Your Name'
E
E     [0m[91m- Your Name[39;49;00m[90m[39;49;00m
E     [92m+ 186[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_acl_canned_publicreadwrite</summary>

**Test description**

> PutObjectAcl public-read-write; GetObjectAcl shows READ + WRITE grants to AllUsers.

**Error stack trace** — `s3_core` — `failed` — 2.122s

```pytb
s3tests/functional/test_s3.py:4277: in test_object_acl_canned_publicreadwrite
    check_grants(
s3tests/functional/test_s3.py:3929: in check_grants
    assert g['Grantee'].pop('DisplayName', None) == w['DisplayName']
E   AssertionError: assert '186' == 'Your Name'
E
E     [0m[91m- Your Name[39;49;00m[90m[39;49;00m
E     [92m+ 186[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_acl_canned_authenticatedread</summary>

**Test description**

> PutObjectAcl authenticated-read; GetObjectAcl shows READ to AuthenticatedUsers.

**Error stack trace** — `s3_core` — `failed` — 2.285s

```pytb
s3tests/functional/test_s3.py:4318: in test_object_acl_canned_authenticatedread
    check_grants(
s3tests/functional/test_s3.py:3929: in check_grants
    assert g['Grantee'].pop('DisplayName', None) == w['DisplayName']
E   AssertionError: assert '186' == 'Your Name'
E
E     [0m[91m- Your Name[39;49;00m[90m[39;49;00m
E     [92m+ 186[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_acl_canned_bucketownerread</summary>

**Test description**

> PutObjectAcl bucket-owner-read; bucket owner gets READ on objects owned by another user.

**Error stack trace** — `s3_core` — `failed` — 1.75s

```pytb
s3tests/functional/test_s3.py:4347: in test_object_acl_canned_bucketownerread
    alt_client.put_object(Bucket=bucket_name, Key='foo', Body='bar')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.AccessDenied: An error occurred (AccessDenied) when calling the PutObject operation: Access Denied
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_acl_canned_bucketownerfullcontrol</summary>

**Test description**

> PutObjectAcl bucket-owner-full-control transfers ownership-equivalent grants to the bucket owner.

**Error stack trace** — `s3_core` — `failed` — 1.946s

```pytb
s3tests/functional/test_s3.py:4389: in test_object_acl_canned_bucketownerfullcontrol
    alt_client.put_object(Bucket=bucket_name, Key='foo', Body='bar')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.AccessDenied: An error occurred (AccessDenied) when calling the PutObject operation: Access Denied
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_acl_full_control_verify_attributes</summary>

**Test description**

> Object attributes (size, etag) are preserved across ACL changes.

**Error stack trace** — `s3_core` — `failed` — 2.531s

```pytb
s3tests/functional/test_s3.py:4497: in test_object_acl_full_control_verify_attributes
    main_client.put_object_acl(Bucket=bucket_name, Key='foo', AccessControlPolicy=grants)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InvalidArgument) when calling the PutObjectAcl operation: Invalid canonical user
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_acl_revoke_all</summary>

**Test description**

> PutBucketAcl with no grants is rejected (the owner FULL_CONTROL grant cannot be revoked).

**Error stack trace** — `s3_core` — `failed` — 2.391s

```pytb
s3tests/functional/test_s3.py:5039: in test_bucket_acl_revoke_all
    assert len(response['Grants']) == 0
E   AssertionError: assert 1 == 0
E    +  where 1 = len([{'Grantee': {'DisplayName': '186', 'ID': '186', 'Type': 'CanonicalUser'}, 'Permission': 'FULL_CONTROL'}])
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_access_bucket_private_object_private</summary>

**Test description**

> Both private; alt user cannot GET either object, ListObjects, or PUT.

**Error stack trace** — `s3_core` — `failed` — 2.864s

```pytb
s3tests/functional/test_s3.py:5093: in test_access_bucket_private_object_private
    check_access_denied(alt_client.get_object, Bucket=bucket_name, Key=key1)
s3tests/functional/test_s3.py:3904: in check_access_denied
    e = assert_raises(ClientError, fn, *args, **kwargs)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_access_bucket_private_objectv2_private</summary>

**Test description**

> Both bucket and object ACLs private; alt user fails GET on either object, ListObjectsV2 on the bucket, and PUT to any key.

**Error stack trace** — `list_objects_v2` — `failed` — 2.781s

```pytb
s3tests/functional/test_s3.py:5121: in test_access_bucket_private_objectv2_private
    check_access_denied(alt_client.get_object, Bucket=bucket_name, Key=key1)
s3tests/functional/test_s3.py:3904: in check_access_denied
    e = assert_raises(ClientError, fn, *args, **kwargs)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_access_bucket_private_object_publicread</summary>

**Test description**

> Bucket private, object public-read; alt user can GET that one object only.

**Error stack trace** — `s3_core` — `failed` — 3.264s

```pytb
s3tests/functional/test_s3.py:5155: in test_access_bucket_private_object_publicread
    check_access_denied(alt_client2.get_object, Bucket=bucket_name, Key=key2)
s3tests/functional/test_s3.py:3904: in check_access_denied
    e = assert_raises(ClientError, fn, *args, **kwargs)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_access_bucket_private_objectv2_publicread</summary>

**Test description**

> Bucket private, object public-read; alt user can GET that one object but cannot PUT, GET other objects, or ListObjectsV2.

**Error stack trace** — `list_objects_v2` — `failed` — 3.196s

```pytb
s3tests/functional/test_s3.py:5176: in test_access_bucket_private_objectv2_publicread
    check_access_denied(alt_client2.get_object, Bucket=bucket_name, Key=key2)
s3tests/functional/test_s3.py:3904: in check_access_denied
    e = assert_raises(ClientError, fn, *args, **kwargs)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_access_bucket_private_object_publicreadwrite</summary>

**Test description**

> Bucket private, object public-read-write; alt user can still only GET that object.

**Error stack trace** — `s3_core` — `failed` — 3.196s

```pytb
s3tests/functional/test_s3.py:5196: in test_access_bucket_private_object_publicreadwrite
    check_access_denied(alt_client2.get_object, Bucket=bucket_name, Key=key2)
s3tests/functional/test_s3.py:3904: in check_access_denied
    e = assert_raises(ClientError, fn, *args, **kwargs)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_access_bucket_private_objectv2_publicreadwrite</summary>

**Test description**

> Bucket private, object public-read-write; alt user can still only GET that one object (private bucket prevents the write); cannot ListObjectsV2.

**Error stack trace** — `list_objects_v2` — `failed` — 2.901s

```pytb
s3tests/functional/test_s3.py:5217: in test_access_bucket_private_objectv2_publicreadwrite
    check_access_denied(alt_client2.get_object, Bucket=bucket_name, Key=key2)
s3tests/functional/test_s3.py:3904: in check_access_denied
    e = assert_raises(ClientError, fn, *args, **kwargs)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_access_bucket_publicread_object_private</summary>

**Test description**

> Bucket public-read, object private; alt user can ListObjects but cannot GET the private object.

**Error stack trace** — `s3_core` — `failed` — 2.752s

```pytb
s3tests/functional/test_s3.py:5229: in test_access_bucket_publicread_object_private
    check_access_denied(alt_client.get_object, Bucket=bucket_name, Key=key1)
s3tests/functional/test_s3.py:3904: in check_access_denied
    e = assert_raises(ClientError, fn, *args, **kwargs)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_access_bucket_publicread_object_publicread</summary>

**Test description**

> Both public-read; alt user can ListObjects and GET; cannot PUT.

**Error stack trace** — `s3_core` — `failed` — 3.547s

```pytb
s3tests/functional/test_s3.py:5256: in test_access_bucket_publicread_object_publicread
    check_access_denied(alt_client2.get_object, Bucket=bucket_name, Key=key2)
s3tests/functional/test_s3.py:3904: in check_access_denied
    e = assert_raises(ClientError, fn, *args, **kwargs)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_access_bucket_publicread_object_publicreadwrite</summary>

**Test description**

> Bucket public-read, object public-read-write; alt user can GET; cannot ListObjects-Write.

**Error stack trace** — `s3_core` — `failed` — 3.352s

```pytb
s3tests/functional/test_s3.py:5282: in test_access_bucket_publicread_object_publicreadwrite
    check_access_denied(alt_client2.get_object, Bucket=bucket_name, Key=key2)
s3tests/functional/test_s3.py:3904: in check_access_denied
    e = assert_raises(ClientError, fn, *args, **kwargs)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_access_bucket_publicreadwrite_object_private</summary>

**Test description**

> Bucket public-read-write, object private; alt user can ListObjects and PUT; GET on the private object fails.

**Error stack trace** — `s3_core` — `failed` — 2.681s

```pytb
s3tests/functional/test_s3.py:5298: in test_access_bucket_publicreadwrite_object_private
    check_access_denied(alt_client.get_object, Bucket=bucket_name, Key=key1)
s3tests/functional/test_s3.py:3904: in check_access_denied
    e = assert_raises(ClientError, fn, *args, **kwargs)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_access_bucket_publicreadwrite_object_publicread</summary>

**Test description**

> Bucket public-read-write, object public-read; alt user has full operational access.

**Error stack trace** — `s3_core` — `failed` — 2.756s

```pytb
s3tests/functional/test_s3.py:5317: in test_access_bucket_publicreadwrite_object_publicread
    alt_client.put_object(Bucket=bucket_name, Key=key1, Body='barcontent')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.AccessDenied: An error occurred (AccessDenied) when calling the PutObject operation: Access Denied
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_access_bucket_publicreadwrite_object_publicreadwrite</summary>

**Test description**

> Both public-read-write; alt user has full operational access.

**Error stack trace** — `s3_core` — `failed` — 2.728s

```pytb
s3tests/functional/test_s3.py:5334: in test_access_bucket_publicreadwrite_object_publicreadwrite
    alt_client.put_object(Bucket=bucket_name, Key=key1, Body='foooverwrite')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.AccessDenied: An error occurred (AccessDenied) when calling the PutObject operation: Access Denied
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_create_special_key_names</summary>

**Test description**

> Upload, list, GET, and PutObjectAcl across keys containing special characters (space, quote, `$`, `%`, `&`, `'`, `<`, `>`, `_`).

**Error stack trace** — `s3_core` — `failed` — 1.711s

```pytb
s3tests/functional/test_s3.py:5487: in test_bucket_create_special_key_names
    bucket_name = _create_objects(keys=key_names)
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:137: in _create_objects
    obj = bucket.put_object(Body=key, Key=key, **put_object_args)
          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/factory.py:581: in do_action
    response = action(self, *args, **kwargs)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/action.py:88: in __call__
    response = getattr(parent.meta.client, operation_name)(*args, **params)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the PutObject operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_copy_zero_size</summary>

**Test description**

> CopyObject from a zero-byte source; destination must report ContentLength=0.

**Error stack trace** — `copy` — `failed` — 8.89s

```pytb
s3tests/functional/test_s3.py:5519: in test_object_copy_zero_size
    client.put_object(Bucket=bucket_name, Key=key, Body=fp_a)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_copy_16m</summary>

**Test description**

> CopyObject of a 16 MB object via single-part CopyObject (not multipart); destination ContentLength must equal source.

**Error stack trace** — `copy` — `failed` — 16.071s

```pytb
s3tests/functional/test_s3.py:5533: in test_object_copy_16m
    client.put_object(Bucket=bucket_name, Key=key1, Body=bytearray(16*1024*1024))
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (BadDigest) when calling the PutObject operation (reached max retries: 4): BadDigest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_copy_not_owned_bucket</summary>

**Test description**

> Alt user attempts CopyObject from a bucket they don't own to their own bucket; expects 403.

**Error stack trace** — `copy` — `failed` — 2.93s

```pytb
s3tests/functional/test_s3.py:5631: in test_object_copy_not_owned_bucket
    e = assert_raises(ClientError, alt_client.copy, copy_source, bucket_name2, 'bar321foo')
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_copy_not_owned_object_bucket</summary>

**Test description**

> After main user grants FULL_CONTROL via object and bucket ACLs, the alt user can CopyObject the granted source.

**Error stack trace** — `copy` — `failed` — 2.233s

```pytb
s3tests/functional/test_s3.py:5647: in test_object_copy_not_owned_object_bucket
    client.put_object_acl(Bucket=bucket_name, Key='foo123bar', AccessControlPolicy=grants)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InvalidArgument) when calling the PutObjectAcl operation: Invalid canonical user
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_copy_versioned_url_encoding</summary>

**Test description**

> CopyObject of a key whose name contains `?` to a destination whose name contains `&`; both keys must roundtrip cleanly via the client's URL-encoding.

**Error stack trace** — `copy` — `failed` — 2.007s

```pytb
s3tests/functional/test_s3.py:5811: in test_object_copy_versioned_url_encoding
    src = bucket.put_object(Key=src_key)
          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/factory.py:581: in do_action
    response = action(self, *args, **kwargs)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/boto3/resources/action.py:88: in __call__
    response = getattr(parent.meta.client, operation_name)(*args, **params)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the PutObject operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_copy_versioning_multipart_upload</summary>

**Test description**

> CopyObject of a 30 MB multipart-uploaded source preserves body, length, metadata, and Content-Type across same-bucket and cross-bucket copies.

**Error stack trace** — `copy` — `failed` — 12.704s

```pytb
s3tests/functional/test_s3.py:5931: in test_object_copy_versioning_multipart_upload
    client.copy_object(Bucket=bucket_name, CopySource=copy_source, Key=key2)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (BadDigest) when calling the CopyObject operation (reached max retries: 4): BadDigest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_multipart_upload_complete_without_create</summary>

**Test description**

> CompleteMultipartUpload with an invented UploadId expects 404 NoSuchUpload.

**Error stack trace** — `s3_core` — `failed` — 27.873s

```pytb
s3tests/functional/test_s3.py:6016: in test_multipart_upload_complete_without_create
    assert status == 404
E   assert 502 == 404
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_multipart_copy_special_names</summary>

**Test description**

> UploadPartCopy from sources whose keys contain space, `_`, `__`, and `?versionId`; each completes intact.

**Error stack trace** — `copy` — `failed` — 2.402s

```pytb
s3tests/functional/test_s3.py:6202: in test_multipart_copy_special_names
    _create_key_with_random_content(src_key, bucket_name=src_bucket_name)
s3tests/functional/test_s3.py:6042: in _create_key_with_random_content
    client.put_object(Bucket=bucket_name, Key=keyname, Body=data)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the PutObject operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_abort_multipart_upload_not_found</summary>

**Test description**

> AbortMultipartUpload with an invented UploadId expects 404 NoSuchUpload.

**Error stack trace** — `s3_core` — `failed` — 7.025s

```pytb
s3tests/functional/test_s3.py:6503: in test_abort_multipart_upload_not_found
    client.put_object(Bucket=bucket_name, Key=key)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_list_multipart_upload_owner</summary>

**Test description**

> ListMultipartUploads returns the Owner who initiated each upload.

**Error stack trace** — `s3_core` — `failed` — 2.132s

```pytb
s3tests/functional/test_s3.py:6560: in test_list_multipart_upload_owner
    upload2 = client2.create_multipart_upload(Bucket=bucket_name, Key=key2)['UploadId']
              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.AccessDenied: An error occurred (AccessDenied) when calling the CreateMultipartUpload operation: Access Denied
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_100_continue</summary>

**Test description**

> PutObject sends Expect:100-continue; server returns 100 before body is sent.

**Error stack trace** — `s3_core` — `failed` — 2.253s

```pytb
s3tests/functional/test_s3.py:6860: in test_100_continue
    assert status == '403'
E   AssertionError: assert '100' == '403'
E
E     [0m[91m- 403[39;49;00m[90m[39;49;00m
E     [92m+ 100[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_set_cors</summary>

**Test description**

> PutBucketCors round-trips a CORS rule via Put/Get/DeleteBucketCors.

**Error stack trace** — `s3_core` — `failed` — 2.269s

```pytb
s3tests/functional/test_s3.py:6904: in test_set_cors
    client.delete_bucket_cors(Bucket=bucket_name)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.AccessDenied: An error occurred (AccessDenied) when calling the DeleteBucketCors operation: Access Denied
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_cors_presigned_get_object</summary>

**Test description**

> CORS preflight then presigned GET succeeds for the allowed origin.

**Error stack trace** — `s3_core` — `failed` — 13.373s

```pytb
s3tests/functional/test_s3.py:7082: in test_cors_presigned_get_object
    _test_cors_options_presigned_method(
s3tests/functional/test_s3.py:7043: in _test_cors_options_presigned_method
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read', client=client)
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_cors_presigned_get_object_tenant</summary>

**Test description**

> Tenant-scoped variant.

**Error stack trace** — `s3_core` — `failed` — 9.241s

```pytb
s3tests/functional/test_s3.py:7088: in test_cors_presigned_get_object_tenant
    _test_cors_options_presigned_method(
s3tests/functional/test_s3.py:7043: in _test_cors_options_presigned_method
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read', client=client)
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_cors_presigned_get_object_v2</summary>

**Test description**

> SigV2 variant.

**Error stack trace** — `s3_core` — `failed` — 1.399s

```pytb
s3tests/functional/test_s3.py:7095: in test_cors_presigned_get_object_v2
    _test_cors_options_presigned_method(
s3tests/functional/test_s3.py:7043: in _test_cors_options_presigned_method
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read', client=client)
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3282: in _setup_bucket_object_acl
    client.create_bucket(ACL=bucket_acl, Bucket=bucket_name)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the CreateBucket operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_cors_presigned_get_object_tenant_v2</summary>

**Test description**

> Tenant + SigV2 variant.

**Error stack trace** — `s3_core` — `failed` — 1.288s

```pytb
s3tests/functional/test_s3.py:7102: in test_cors_presigned_get_object_tenant_v2
    _test_cors_options_presigned_method(
s3tests/functional/test_s3.py:7043: in _test_cors_options_presigned_method
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read', client=client)
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3282: in _setup_bucket_object_acl
    client.create_bucket(ACL=bucket_acl, Bucket=bucket_name)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the CreateBucket operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_cors_presigned_put_object</summary>

**Test description**

> CORS preflight then presigned PUT succeeds.

**Error stack trace** — `s3_core` — `failed` — 5.131s

```pytb
s3tests/functional/test_s3.py:7108: in test_cors_presigned_put_object
    _test_cors_options_presigned_method(
s3tests/functional/test_s3.py:7043: in _test_cors_options_presigned_method
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read', client=client)
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_cors_presigned_put_object_with_acl</summary>

**Test description**

> Same with x-amz-acl in the presigned URL.

**Error stack trace** — `s3_core` — `failed` — 12.463s

```pytb
s3tests/functional/test_s3.py:7114: in test_cors_presigned_put_object_with_acl
    _test_cors_options_presigned_method(
s3tests/functional/test_s3.py:7043: in _test_cors_options_presigned_method
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read', client=client)
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_cors_presigned_put_object_v2</summary>

**Test description**

> SigV2 variant.

**Error stack trace** — `s3_core` — `failed` — 1.237s

```pytb
s3tests/functional/test_s3.py:7122: in test_cors_presigned_put_object_v2
    _test_cors_options_presigned_method(
s3tests/functional/test_s3.py:7043: in _test_cors_options_presigned_method
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read', client=client)
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3282: in _setup_bucket_object_acl
    client.create_bucket(ACL=bucket_acl, Bucket=bucket_name)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the CreateBucket operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_cors_presigned_put_object_tenant_v2</summary>

**Test description**

> Tenant + SigV2 variant.

**Error stack trace** — `s3_core` — `failed` — 1.256s

```pytb
s3tests/functional/test_s3.py:7129: in test_cors_presigned_put_object_tenant_v2
    _test_cors_options_presigned_method(
s3tests/functional/test_s3.py:7043: in _test_cors_options_presigned_method
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read', client=client)
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3282: in _setup_bucket_object_acl
    client.create_bucket(ACL=bucket_acl, Bucket=bucket_name)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the CreateBucket operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_cors_presigned_put_object_tenant</summary>

**Test description**

> Tenant variant.

**Error stack trace** — `s3_core` — `failed` — 6.022s

```pytb
s3tests/functional/test_s3.py:7135: in test_cors_presigned_put_object_tenant
    _test_cors_options_presigned_method(
s3tests/functional/test_s3.py:7043: in _test_cors_options_presigned_method
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read', client=client)
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_cors_presigned_put_object_tenant_with_acl</summary>

**Test description**

> Tenant + ACL variant.

**Error stack trace** — `s3_core` — `failed` — 10.934s

```pytb
s3tests/functional/test_s3.py:7141: in test_cors_presigned_put_object_tenant_with_acl
    _test_cors_options_presigned_method(
s3tests/functional/test_s3.py:7043: in _test_cors_options_presigned_method
    bucket_name = _setup_bucket_object_acl('public-read', 'public-read', client=client)
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:3283: in _setup_bucket_object_acl
    client.put_object(ACL=object_acl, Bucket=bucket_name, Key='foo')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_set_bucket_tagging</summary>

**Test description**

> PutBucketTagging round-trip; GetBucketTagging before Put returns 404 NoSuchTagSet, DeleteBucketTagging returns 204 and subsequent Get returns 404 again.

**Error stack trace** — `tagging` — `failed` — 2.25s

```pytb
s3tests/functional/test_s3.py:7173: in test_set_bucket_tagging
    response = client.delete_bucket_tagging(Bucket=bucket_name)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.AccessDenied: An error occurred (AccessDenied) when calling the DeleteBucketTagging operation: Access Denied
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_atomic_dual_write_1mb</summary>

**Test description**

> Two-writer atomicity check at 1 MB.

**Error stack trace** — `s3_core` — `failed` — 8.904s

```pytb
s3tests/functional/test_s3.py:7371: in test_atomic_dual_write_1mb
    _test_atomic_dual_write(1024*1024)
s3tests/functional/test_s3.py:7354: in _test_atomic_dual_write
    client.put_object(Bucket=bucket_name, Key=objname)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_atomic_dual_write_4mb</summary>

**Test description**

> At 4 MB.

**Error stack trace** — `s3_core` — `failed` — 11.392s

```pytb
s3tests/functional/test_s3.py:7374: in test_atomic_dual_write_4mb
    _test_atomic_dual_write(1024*1024*4)
s3tests/functional/test_s3.py:7354: in _test_atomic_dual_write
    client.put_object(Bucket=bucket_name, Key=objname)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_atomic_dual_write_8mb</summary>

**Test description**

> At 8 MB.

**Error stack trace** — `s3_core` — `failed` — 12.613s

```pytb
s3tests/functional/test_s3.py:7377: in test_atomic_dual_write_8mb
    _test_atomic_dual_write(1024*1024*8)
s3tests/functional/test_s3.py:7354: in _test_atomic_dual_write
    client.put_object(Bucket=bucket_name, Key=objname)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_ranged_request_empty_object</summary>

**Test description**

> Range on a 0-byte object expects 416 or appropriate empty handling.

**Error stack trace** — `s3_core` — `failed` — 6.902s

```pytb
s3tests/functional/test_s3.py:7646: in test_ranged_request_empty_object
    client.put_object(Bucket=bucket_name, Key='testobj', Body=content)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_versioning_obj_create_versions_remove_special_names</summary>

**Test description**

> Same create/remove-all flow but against keys with special characters (`_testobj`, `_`, `:`, ` `).

**Error stack trace** — `s3_core` — `failed` — 30.36s

```pytb
s3tests/functional/test_s3.py:8025: in test_versioning_obj_create_versions_remove_special_names
    (version_ids, contents) = create_multiple_versions(client, bucket_name, key, num_versions)
                              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/test_s3.py:7693: in create_multiple_versions
    response = client.put_object(Bucket=bucket_name, Key=key, Body=body)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the PutObject operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_versioned_object_acl</summary>

**Test description**

> GetObjectAcl with a specific VersionId returns default owner FULL_CONTROL; PutObjectAcl ACL='public-read' with VersionId scopes the grant to that version; new put_object creates a fresh version with default ACL.

**Error stack trace** — `s3_core` — `failed` — 2.596s

```pytb
s3tests/functional/test_s3.py:8252: in test_versioned_object_acl
    assert response['Owner']['DisplayName'] == display_name
E   AssertionError: assert '186' == 'Your Name'
E
E     [0m[91m- Your Name[39;49;00m[90m[39;49;00m
E     [92m+ 186[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_versioned_object_acl_no_version_specified</summary>

**Test description**

> PutObjectAcl without VersionId targets the current head version; verifies that ACL change is observable via GetObjectAcl with the head VersionId.

**Error stack trace** — `s3_core` — `failed` — 3.064s

```pytb
s3tests/functional/test_s3.py:8321: in test_versioned_object_acl_no_version_specified
    assert response['Owner']['DisplayName'] == display_name
E   AssertionError: assert '186' == 'Your Name'
E
E     [0m[91m- Your Name[39;49;00m[90m[39;49;00m
E     [92m+ 186[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_lifecycle_delete</summary>

**Test description**

> GetBucketLifecycleConfiguration on a fresh bucket returns 404 NoSuchLifecycleConfiguration; DeleteBucketLifecycle returns 204 even when no config exists.

**Error stack trace** — `lifecycle` — `failed` — 1.965s

```pytb
s3tests/functional/test_s3.py:8472: in test_lifecycle_delete
    response = client.delete_bucket_lifecycle(Bucket=bucket_name)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.AccessDenied: An error occurred (AccessDenied) when calling the DeleteBucketLifecycle operation: Access Denied
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_sse_kms_method_head</summary>

**Test description**

> After SSE-KMS PutObject, HeadObject returns x-amz-server-side-encryption=aws:kms and the key id; HeadObject sent with SSE-KMS request headers expects 400.

**Error stack trace** — `encryption` — `failed` — 1.82s

```pytb
s3tests/functional/test_s3.py:11244: in test_sse_kms_method_head
    client.put_object(Bucket=bucket_name, Key=key, Body=data)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_sse_kms_present</summary>

**Test description**

> SSE-KMS PutObject and GetObject without re-sending KMS headers; body must come back intact.

**Error stack trace** — `encryption` — `failed` — 1.848s

```pytb
s3tests/functional/test_s3.py:11271: in test_sse_kms_present
    client.put_object(Bucket=bucket_name, Key=key, Body=data)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_sse_kms_multipart_upload</summary>

**Test description**

> SSE-KMS multipart upload of 30 MB; verifies length, metadata, Content-Type, body, and range reads.

**Error stack trace** — `encryption` — `failed` — 2.187s

```pytb
s3tests/functional/test_s3.py:11327: in test_sse_kms_multipart_upload
    (upload_id, data, parts) = _multipart_upload_enc(client, bucket_name, key, objlen,
s3tests/functional/test_s3.py:10860: in _multipart_upload_enc
    response = client.create_multipart_upload(Bucket=bucket_name, Key=key, Metadata=metadata)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the CreateMultipartUpload operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_sse_kms_multipart_invalid_chunks_1</summary>

**Test description**

> SSE-KMS multipart with different KMS key ids between init and parts (no assertion — just verifies the upload helper attempts the call).

**Error stack trace** — `encryption` — `failed` — 1.956s

```pytb
s3tests/functional/test_s3.py:11377: in test_sse_kms_multipart_invalid_chunks_1
    _multipart_upload_enc(client, bucket_name, key, objlen, part_size=5*1024*1024,
s3tests/functional/test_s3.py:10860: in _multipart_upload_enc
    response = client.create_multipart_upload(Bucket=bucket_name, Key=key, Metadata=metadata)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the CreateMultipartUpload operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_sse_kms_multipart_invalid_chunks_2</summary>

**Test description**

> SSE-KMS multipart where parts use a non-existent KMS key id (no assertion — just verifies the upload helper attempts the call).

**Error stack trace** — `encryption` — `failed` — 1.853s

```pytb
s3tests/functional/test_s3.py:11403: in test_sse_kms_multipart_invalid_chunks_2
    _multipart_upload_enc(client, bucket_name, key, objlen, part_size=5*1024*1024,
s3tests/functional/test_s3.py:10860: in _multipart_upload_enc
    response = client.create_multipart_upload(Bucket=bucket_name, Key=key, Metadata=metadata)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the CreateMultipartUpload operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_sse_kms_post_object_authenticated_request</summary>

**Test description**

> POST presigned upload with SSE-KMS conditions; subsequent GET returns the body.

**Error stack trace** — `encryption` — `failed` — 1.797s

```pytb
s3tests/functional/test_s3.py:11448: in test_sse_kms_post_object_authenticated_request
    assert r.status_code == 204
E   assert 400 == 204
E    +  where 400 = <Response [400]>.status_code
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_sse_kms_transfer_1b</summary>

**Test description**

> SSE-KMS round-trip at 1 byte. Skipped when [s3 main] has no kms_keyid.

**Error stack trace** — `encryption` — `failed` — 1.847s

```pytb
s3tests/functional/test_s3.py:11460: in test_sse_kms_transfer_1b
    _test_sse_kms_customer_write(1, key_id = kms_keyid)
s3tests/functional/test_s3.py:11222: in _test_sse_kms_customer_write
    client.put_object(Bucket=bucket_name, Key='testobj', Body=data)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_sse_kms_transfer_1kb</summary>

**Test description**

> SSE-KMS round-trip at 1 KB. Skipped when [s3 main] has no kms_keyid.

**Error stack trace** — `encryption` — `failed` — 1.873s

```pytb
s3tests/functional/test_s3.py:11469: in test_sse_kms_transfer_1kb
    _test_sse_kms_customer_write(1024, key_id = kms_keyid)
s3tests/functional/test_s3.py:11222: in _test_sse_kms_customer_write
    client.put_object(Bucket=bucket_name, Key='testobj', Body=data)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_sse_kms_transfer_1MB</summary>

**Test description**

> SSE-KMS round-trip at 1 MB. Skipped when [s3 main] has no kms_keyid.

**Error stack trace** — `encryption` — `failed` — 1.883s

```pytb
s3tests/functional/test_s3.py:11478: in test_sse_kms_transfer_1MB
    _test_sse_kms_customer_write(1024*1024, key_id = kms_keyid)
s3tests/functional/test_s3.py:11222: in _test_sse_kms_customer_write
    client.put_object(Bucket=bucket_name, Key='testobj', Body=data)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_sse_kms_transfer_13b</summary>

**Test description**

> SSE-KMS round-trip at 13 bytes. Skipped when [s3 main] has no kms_keyid.

**Error stack trace** — `encryption` — `failed` — 1.966s

```pytb
s3tests/functional/test_s3.py:11487: in test_sse_kms_transfer_13b
    _test_sse_kms_customer_write(13, key_id = kms_keyid)
s3tests/functional/test_s3.py:11222: in _test_sse_kms_customer_write
    client.put_object(Bucket=bucket_name, Key='testobj', Body=data)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_policy_acl</summary>

**Test description**

> A Deny ListBucket policy combined with an authenticated-read bucket ACL must result in 403 AccessDenied for the alt user (policy overrides ACL allow).

**Error stack trace** — `bucket_policy` — `failed` — 2.509s

```pytb
s3tests/functional/test_s3.py:11676: in test_bucket_policy_acl
    e = assert_raises(ClientError, alt_client.list_objects, Bucket=bucket_name)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucketv2_policy_acl</summary>

**Test description**

> Same as test_bucket_policy_acl but exercises ListObjectsV2 on the alt user; expects 403 AccessDenied.

**Error stack trace** — `bucket_policy` — `failed` — 2.226s

```pytb
s3tests/functional/test_s3.py:11712: in test_bucketv2_policy_acl
    e = assert_raises(ClientError, alt_client.list_objects_v2, Bucket=bucket_name)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_policy_different_tenant</summary>

**Test description**

> Allow-ListBucket policy on a global-tenant bucket; a tenanted client must be able to list it using the `:bucket` cross-tenant syntax.

**Error stack trace** — `bucket_policy` — `failed` — 2.3s

```pytb
s3tests/functional/test_s3.py:11748: in test_bucket_policy_different_tenant
    response = tenant_client.list_objects(Bucket=":{}".format(bucket_name))
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the ListObjects operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_policy_tenanted_bucket</summary>

**Test description**

> Allow-ListBucket policy on a tenanted bucket; the global-tenant client must be able to list it via `tenant:bucket` syntax.

**Error stack trace** — `bucket_policy` — `failed` — 2.201s

```pytb
s3tests/functional/test_s3.py:11817: in test_bucket_policy_tenanted_bucket
    response = client.list_objects(Bucket="{}:{}".format(tenant, bucket_name))
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the ListObjects operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_policy_set_condition_operator_end_with_IfExists</summary>

**Test description**

> Policy with a `StringLikeIfExists` aws:Referer condition; matching referers receive HTTP 200, non-matching get 403.

**Error stack trace** — `bucket_policy` — `failed` — 7.116s

```pytb
s3tests/functional/test_s3.py:11902: in test_bucket_policy_set_condition_operator_end_with_IfExists
    client.put_object(Bucket=bucket_name, Key=key)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_versioning_bucket_atomic_upload_return_version_id</summary>

**Test description**

> PutObject returns a VersionId on versioning-enabled buckets and omits it on default/suspended buckets.

**Error stack trace** — `s3_core` — `failed` — 13.824s

```pytb
s3tests/functional/test_s3.py:12389: in test_versioning_bucket_atomic_upload_return_version_id
    response = client.put_object(Bucket=bucket_name, Key=key)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_policy_get_obj_existing_tag</summary>

**Test description**

> Policy with `s3:ExistingObjectTag/security=public` condition; alt user can GET the matching-tag object only, others return 403.

**Error stack trace** — `tagging` — `failed` — 3.022s

```pytb
s3tests/functional/test_s3.py:12499: in test_bucket_policy_get_obj_existing_tag
    e = assert_raises(ClientError, alt_client.get_object, Bucket=bucket_name, Key='privatetag')
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_policy_get_obj_tagging_existing_tag</summary>

**Test description**

> Same ExistingObjectTag condition scoped to GetObjectTagging; alt user can read tags only on the matching object, other tagging reads return 403.

**Error stack trace** — `tagging` — `failed` — 2.865s

```pytb
s3tests/functional/test_s3.py:12555: in test_bucket_policy_get_obj_tagging_existing_tag
    e = assert_raises(ClientError, alt_client.get_object, Bucket=bucket_name, Key='publictag')
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_policy_upload_part_copy</summary>

**Test description**

> Policy granting GetObject on `public/*` only; alt user can UploadPartCopy from public/_ keys but is denied for private/_ sources.

**Error stack trace** — `copy` — `failed` — 4.381s

```pytb
s3tests/functional/test_s3.py:12691: in test_bucket_policy_upload_part_copy
    check_access_denied(alt_client.upload_part_copy, Bucket=bucket_name2, Key='new_foo2', PartNumber=1, UploadId=upload_id, CopySource=copy_source)
s3tests/functional/test_s3.py:3904: in check_access_denied
    e = assert_raises(ClientError, fn, *args, **kwargs)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_policy_put_obj_grant</summary>

**Test description**

> Policy requiring `s3:x-amz-grant-full-control` matching the bucket owner; verifies object ownership transfer to bucket owner when header is present vs retained by alt uploader when absent.

**Error stack trace** — `bucket_policy` — `failed` — 2.804s

```pytb
s3tests/functional/test_s3.py:12874: in test_bucket_policy_put_obj_grant
    response = alt_client.put_object(Bucket=bucket_name, Key=key1, Body=key1)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InvalidArgument) when calling the PutObject operation: Invalid canonical user
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_policy_put_obj_s3_noenc</summary>

**Test description**

> Deny PutObject when x-amz-server-side-encryption header is absent; unencrypted PutObject is denied, AES256 PutObject succeeds.

**Error stack trace** — `encryption` — `failed` — 10.182s

```pytb
s3tests/functional/test_s3.py:13021: in test_bucket_policy_put_obj_s3_noenc
    response = client.put_object(Bucket=bucket_name, Key=key1_str, ServerSideEncryption='AES256')
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_policy_put_obj_s3_incorrect_algo_sse_s3</summary>

**Test description**

> Deny PutObject unless server-side-encryption header equals AES256; AES192 is denied, AES256 succeeds.

**Error stack trace** — `encryption` — `failed` — 12.562s

```pytb
s3tests/functional/test_s3.py:13050: in test_bucket_policy_put_obj_s3_incorrect_algo_sse_s3
    response = client.put_object(Bucket=bucket_name, Key=key1_str, ServerSideEncryption='AES256')
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_policy_put_obj_kms_noenc</summary>

**Test description**

> Policy requires `aws:kms` SSE and forbids unencrypted; KMS PutObject succeeds, unencrypted is denied. Skipped when [s3 main] has no kms_keyid configured.

**Error stack trace** — `encryption` — `failed` — 1.902s

```pytb
s3tests/functional/test_s3.py:13140: in test_bucket_policy_put_obj_kms_noenc
    response = client.put_object(Bucket=bucket_name, Key=key1_str,
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_policy_put_obj_request_obj_tag</summary>

**Test description**

> Policy allows PutObject only when `s3:RequestObjectTag/security=public`; alt user is denied without the tag header and succeeds with `x-amz-tagging: security=public`.

**Error stack trace** — `tagging` — `failed` — 2.157s

```pytb
s3tests/functional/test_s3.py:13216: in test_bucket_policy_put_obj_request_obj_tag
    alt_client.put_object(Bucket=bucket_name, Key=key1_str, Body=key1_str)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.AccessDenied: An error occurred (AccessDenied) when calling the PutObject operation: Access Denied
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_policy_get_obj_acl_existing_tag</summary>

**Test description**

> Policy with ExistingObjectTag condition scoped to GetObjectAcl; alt user can read ACL of matching-tag object only, other operations return 403.

**Error stack trace** — `tagging` — `failed` — 3.032s

```pytb
s3tests/functional/test_s3.py:13266: in test_bucket_policy_get_obj_acl_existing_tag
    e = assert_raises(ClientError, alt_client.get_object, Bucket=bucket_name, Key='publictag')
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_object_ifmatch_failed</summary>

**Test description**

> CopyObject with CopySourceIfMatch=<wrong-etag> expects 412 PreconditionFailed.

**Error stack trace** — `copy` — `failed` — 2.113s

```pytb
s3tests/functional/test_s3.py:14048: in test_copy_object_ifmatch_failed
    assert status == 412
E   assert 400 == 412
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_object_ifnonematch_failed</summary>

**Test description**

> CopyObject with CopySourceIfNoneMatch=<wrong-etag> succeeds because the source does not match.

**Error stack trace** — `copy` — `failed` — 2.215s

```pytb
s3tests/functional/test_s3.py:14071: in test_copy_object_ifnonematch_failed
    client.copy_object(Bucket=bucket_name, CopySource=bucket_name+'/foo', CopySourceIfNoneMatch='ABCORZ', Key='bar')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InvalidArgument) when calling the CopyObject operation: Invalid copy source conditions
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_read_unreadable</summary>

**Test description**

> GetObject of a key whose name contains unreadable bytes; client must round-trip the URL-encoded name.

**Error stack trace** — `s3_core` — `failed` — 1.899s

```pytb
s3tests/functional/test_s3.py:14083: in test_object_read_unreadable
    assert status == 400
E   assert 403 == 400
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_get_undefined_public_block</summary>

**Test description**

> GetPublicAccessBlock on a bucket without configuration expects NoSuchPublicAccessBlockConfiguration.

**Error stack trace** — `s3_core` — `failed` — 1.767s

```pytb
s3tests/functional/test_s3.py:14225: in test_get_undefined_public_block
    resp = client.delete_public_access_block(Bucket=bucket_name)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.AccessDenied: An error occurred (AccessDenied) when calling the DeletePublicAccessBlock operation: Access Denied
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_get_public_block_deny_bucket_policy</summary>

**Test description**

> PutPublicAccessBlock with RestrictPublicBuckets blocks subsequent public bucket policies.

**Error stack trace** — `s3_core` — `failed` — 2.12s

```pytb
s3tests/functional/test_s3.py:14260: in test_get_public_block_deny_bucket_policy
    e = assert_raises(ClientError, client.get_public_access_block, Bucket=bucket_name)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_block_public_object_canned_acls</summary>

**Test description**

> With BlockPublicAcls=true, PutObject ACL=public-read is rejected.

**Error stack trace** — `s3_core` — `failed` — 7.534s

```pytb
s3tests/functional/test_s3.py:14337: in test_block_public_object_canned_acls
    client.put_object(Bucket=bucket_name, Key='foo4', Body='', ACL='private')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_block_public_restrict_public_buckets</summary>

**Test description**

> With RestrictPublicBuckets=true, anonymous list/get on a public bucket is denied even if its ACL is public.

**Error stack trace** — `s3_core` — `failed` — 1.87s

```pytb
s3tests/functional/test_s3.py:14380: in test_block_public_restrict_public_buckets
    resp = client.delete_public_access_block(Bucket=bucket_name)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.AccessDenied: An error occurred (AccessDenied) when calling the DeletePublicAccessBlock operation: Access Denied
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_ignore_public_acls</summary>

**Test description**

> With IgnorePublicAcls=true, existing public-read ACLs are ignored at access-check time.

**Error stack trace** — `s3_core` — `failed` — 2.535s

```pytb
s3tests/functional/test_s3.py:14438: in test_ignore_public_acls
    check_access_denied(alt_client.list_objects, Bucket=bucket_name)
s3tests/functional/test_s3.py:3904: in check_access_denied
    e = assert_raises(ClientError, fn, *args, **kwargs)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
s3tests/functional/utils.py:19: in assert_raises
    raise AssertionError("%s not raised" % excName)
E   AssertionError: ClientError not raised
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_put_get_delete_public_block</summary>

**Test description**

> PutPublicAccessBlock + GetPublicAccessBlock + DeletePublicAccessBlock round-trip.

**Error stack trace** — `s3_core` — `failed` — 1.836s

```pytb
s3tests/functional/test_s3.py:14458: in test_put_get_delete_public_block
    resp = client.delete_public_access_block(Bucket=bucket_name)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.AccessDenied: An error occurred (AccessDenied) when calling the DeletePublicAccessBlock operation: Access Denied
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_get_bucket_encryption_s3</summary>

**Test description**

> GetBucketEncryption on a fresh bucket returns ServerSideEncryptionConfigurationNotFoundError; after Put it returns the SSE-S3 rule.

**Error stack trace** — `sse_s3` — `failed` — 1.779s

```pytb
s3tests/functional/test_s3.py:14555: in test_get_bucket_encryption_s3
    assert response_code == 'ServerSideEncryptionConfigurationNotFoundError'
E   AssertionError: assert '' == 'ServerSideEn...NotFoundError'
E
E     [0m[91m- ServerSideEncryptionConfigurationNotFoundError[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_get_bucket_encryption_kms</summary>

**Test description**

> GetBucketEncryption on a fresh bucket returns ServerSideEncryptionConfigurationNotFoundError; after Put it returns the SSE-KMS rule with KMSMasterKeyID.

**Error stack trace** — `encryption` — `failed` — 1.946s

```pytb
s3tests/functional/test_s3.py:14578: in test_get_bucket_encryption_kms
    assert response_code == 'ServerSideEncryptionConfigurationNotFoundError'
E   AssertionError: assert '' == 'ServerSideEn...NotFoundError'
E
E     [0m[91m- ServerSideEncryptionConfigurationNotFoundError[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_delete_bucket_encryption_s3</summary>

**Test description**

> DeleteBucketEncryption is idempotent and returns 204 even when no config exists; after a Put + Delete, GetBucketEncryption returns NotFound.

**Error stack trace** — `sse_s3` — `failed` — 1.911s

```pytb
s3tests/functional/test_s3.py:14593: in test_delete_bucket_encryption_s3
    response = client.delete_bucket_encryption(Bucket=bucket_name)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.AccessDenied: An error occurred (AccessDenied) when calling the DeleteBucketEncryption operation: Access Denied
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_delete_bucket_encryption_kms</summary>

**Test description**

> Same idempotency check for the KMS configuration variant.

**Error stack trace** — `encryption` — `failed` — 2.094s

```pytb
s3tests/functional/test_s3.py:14615: in test_delete_bucket_encryption_kms
    response = client.delete_bucket_encryption(Bucket=bucket_name)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.AccessDenied: An error occurred (AccessDenied) when calling the DeleteBucketEncryption operation: Access Denied
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_sse_kms_default_upload_1b</summary>

**Test description**

> With SSE-KMS bucket default, plain PutObject at 1 byte; the stored object must come back with aws:kms encryption and the configured key id.

**Error stack trace** — `encryption` — `failed` — 1.874s

```pytb
s3tests/functional/test_s3.py:14707: in test_sse_kms_default_upload_1b
    _test_sse_kms_default_upload(1)
s3tests/functional/test_s3.py:14692: in _test_sse_kms_default_upload
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_sse_kms_default_upload_1kb</summary>

**Test description**

> SSE-KMS bucket-default upload at 1 KB.

**Error stack trace** — `encryption` — `failed` — 1.921s

```pytb
s3tests/functional/test_s3.py:14714: in test_sse_kms_default_upload_1kb
    _test_sse_kms_default_upload(1024)
s3tests/functional/test_s3.py:14692: in _test_sse_kms_default_upload
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_sse_kms_default_upload_1mb</summary>

**Test description**

> SSE-KMS bucket-default upload at 1 MB.

**Error stack trace** — `encryption` — `failed` — 10.14s

```pytb
s3tests/functional/test_s3.py:14721: in test_sse_kms_default_upload_1mb
    _test_sse_kms_default_upload(1024*1024)
s3tests/functional/test_s3.py:14692: in _test_sse_kms_default_upload
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_sse_kms_default_upload_8mb</summary>

**Test description**

> SSE-KMS bucket-default upload at 8 MB.

**Error stack trace** — `encryption` — `failed` — 3.566s

```pytb
s3tests/functional/test_s3.py:14728: in test_sse_kms_default_upload_8mb
    _test_sse_kms_default_upload(8*1024*1024)
s3tests/functional/test_s3.py:14692: in _test_sse_kms_default_upload
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_sse_kms_default_post_object_authenticated_request</summary>

**Test description**

> POST presigned upload to a bucket with SSE-KMS default; the resulting object reports aws:kms and the key id. Skipped when [s3 main] has no kms_keyid.

**Error stack trace** — `encryption` — `failed` — 1.898s

```pytb
s3tests/functional/test_s3.py:14890: in test_sse_kms_default_post_object_authenticated_request
    assert r.status_code == 204
E   assert 400 == 204
E    +  where 400 = <Response [400]>.status_code
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_multipart_reupload_checksum_and_etag</summary>

**Test description**

> Three-part upload with per-part SHA256 checksums and a composite ETag/checksum; a second identical CompleteMultipartUpload is idempotent and returns the same ETag and ChecksumSHA256.

**Error stack trace** — `checksum` — `failed` — 14.87s

```pytb
s3tests/functional/test_s3.py:15114: in test_multipart_reupload_checksum_and_etag
    assert res1['ETag'] == res2['ETag']
E   assert '"b2add96cc97...cdfc6b7747-3"' == ''
E
E     [0m[92m+ "b2add96cc9702bbf4efb0ccdfc6b7747-3"[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_put_bucket_logging</summary>

**Test description**

> PutBucketLogging round-trips minimal config, SimplePrefix/PartitionedPrefix key formats, and TargetGrants (which RGW silently drops); also asserts the ObjectRollTime and LoggingType extension fields when present.

**Error stack trace** — `bucket_logging` — `failed` — 2.742s

```pytb
s3tests/functional/test_s3.py:15546: in test_put_bucket_logging
    response = client.put_bucket_logging(Bucket=src_bucket_name, BucketLoggingStatus={
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InvalidArgument) when calling the PutBucketLogging operation: Invalid bucket logging destination
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_put_bucket_logging_errors</summary>

**Test description**

> Negative tests for PutBucketLogging — invalid target bucket, missing policy, malformed TargetObjectKeyFormat, etc.

**Error stack trace** — `bucket_logging` — `failed` — 3.505s

```pytb
s3tests/functional/test_s3.py:16556: in test_put_bucket_logging_errors
    response = client.put_bucket_logging(Bucket=log_bucket_name2, BucketLoggingStatus={
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InvalidArgument) when calling the PutBucketLogging operation: Invalid bucket logging destination
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_bucket_logging_owner</summary>

**Test description**

> Log records carry the bucket owner's display name and ID in the Owner field.

**Error stack trace** — `bucket_logging` — `failed` — 2.951s

```pytb
s3tests/functional/test_s3.py:16673: in test_bucket_logging_owner
    response = client.put_bucket_logging(Bucket=src_bucket_name, BucketLoggingStatus={
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InvalidArgument) when calling the PutBucketLogging operation: Invalid bucket logging destination
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_put_bucket_logging_permissions</summary>

**Test description**

> PutBucketLogging on a bucket without the required policy on the log bucket expects 403.

**Error stack trace** — `bucket_logging` — `failed` — 2.345s

```pytb
s3tests/functional/test_s3.py:16637: in _verify_access_denied
    response = client.put_bucket_logging(Bucket=src_bucket_name, BucketLoggingStatus={
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InvalidArgument) when calling the PutBucketLogging operation: Invalid bucket logging destination

During handling of the above exception, another exception occurred:
s3tests/functional/test_s3.py:16704: in test_put_bucket_logging_permissions
    _verify_access_denied(client, src_bucket_name, log_bucket_name, prefix)
s3tests/functional/test_s3.py:16641: in _verify_access_denied
    assert e.response['Error']['Code'] == 'AccessDenied'
E   AssertionError: assert 'InvalidArgument' == 'AccessDenied'
E
E     [0m[91m- AccessDenied[39;49;00m[90m[39;49;00m
E     [92m+ InvalidArgument[39;49;00m[90m[39;49;00m
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_put_bucket_logging_policy_wildcard</summary>

**Test description**

> PutBucketLogging succeeds when the log bucket policy uses a `*` wildcard for the source ARN.

**Error stack trace** — `bucket_logging` — `failed` — 3.007s

```pytb
s3tests/functional/test_s3.py:16886: in test_put_bucket_logging_policy_wildcard
    _put_bucket_logging_policy_wildcard(False)
s3tests/functional/test_s3.py:16818: in _put_bucket_logging_policy_wildcard
    response = client.put_bucket_logging(Bucket=src_bucket_name, BucketLoggingStatus={
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InvalidArgument) when calling the PutBucketLogging operation: Invalid bucket logging destination
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_rm_bucket_logging</summary>

**Test description**

> PutBucketLogging with an empty BucketLoggingStatus disables logging; GetBucketLogging then returns no LoggingEnabled element.

**Error stack trace** — `bucket_logging` — `failed` — 2.463s

```pytb
s3tests/functional/test_s3.py:17245: in test_rm_bucket_logging
    response = client.put_bucket_logging(Bucket=src_bucket_name, BucketLoggingStatus={
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InvalidArgument) when calling the PutBucketLogging operation: Invalid bucket logging destination
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_upload_part_copy_percent_encoded_key</summary>

**Test description**

> UploadPartCopy where the source key contains characters that must be percent-encoded; copy succeeds.

**Error stack trace** — `s3_core` — `failed` — 1.991s

```pytb
s3tests/functional/test_s3.py:19353: in test_upload_part_copy_percent_encoded_key
    s3_client.put_object(
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (SignatureDoesNotMatch) when calling the PutObject operation: The request signature we calculated does not match the signature you provided.
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_put_object_if_match</summary>

**Test description**

> PutObject with conditional IfNoneMatch=`*` and IfMatch=<etag>; verifies 412 PreconditionFailed for stale-etag IfNoneMatch, 404 NoSuchKey for IfMatch on missing key, and success for valid combinations.

**Error stack trace** — `conditional_write` — `failed` — 2.132s

```pytb
s3tests/functional/test_s3.py:19475: in test_put_object_if_match
    etag = client.put_object(Bucket=bucket, Key=key, IfNoneMatch='*')['ETag']
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (PreconditionFailed) when calling the PutObject operation: At least one of the pre-conditions you specified did not hold
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_put_current_object_if_none_match</summary>

**Test description**

> On a versioned bucket, IfNoneMatch only checks the current version; after creating two versions, IfNoneMatch=`*` and IfNoneMatch=<etag-of-current> both return 412.

**Error stack trace** — `conditional_write` — `failed` — 11.136s

```pytb
s3tests/functional/test_s3.py:19587: in test_put_current_object_if_none_match
    response = client.put_object(Bucket=bucket, Key=key, IfNoneMatch=etag)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_put_current_object_if_match</summary>

**Test description**

> On a versioned bucket, IfMatch validates against the current version; etag mismatch returns 412, IfMatch=`*` on missing key returns 404.

**Error stack trace** — `conditional_write` — `failed` — 3.134s

```pytb
s3tests/functional/test_s3.py:19649: in test_put_current_object_if_match
    response = client.put_object(Bucket=bucket, Key=key, IfMatch=etag2)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (PreconditionFailed) when calling the PutObject operation: At least one of the pre-conditions you specified did not hold
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_put_object_current_if_match</summary>

**Test description**

> After PutObject with IfNoneMatch=`*`, repeated PUTs with the same IfNoneMatch return 412; DeleteObject then makes IfMatch=`*` return 404.

**Error stack trace** — `conditional_write` — `failed` — 2.342s

```pytb
s3tests/functional/test_s3.py:19687: in test_put_object_current_if_match
    etag = client.put_object(Bucket=bucket, Key=key, IfNoneMatch='*')['ETag']
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (PreconditionFailed) when calling the PutObject operation: At least one of the pre-conditions you specified did not hold
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_create_bucket_bucket_owner_enforced</summary>

**Test description**

> CreateBucket with ObjectOwnership=BucketOwnerEnforced disables ACLs entirely.

**Error stack trace** — `s3_core` — `failed` — 9.051s

```pytb
s3tests/functional/test_s3.py:20291: in test_create_bucket_bucket_owner_enforced
    _test_object_ownership_bucket_owner_enforced(get_alt_client(), bucket, bucket_owner)
s3tests/functional/test_s3.py:20162: in _test_object_ownership_bucket_owner_enforced
    client.put_object(Bucket=bucket, Key='put-object-no-acl')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_create_bucket_bucket_owner_preferred</summary>

**Test description**

> CreateBucket with BucketOwnerPreferred causes new objects to be owned by the bucket owner when uploaded with bucket-owner-full-control.

**Error stack trace** — `s3_core` — `failed` — 13.841s

```pytb
s3tests/functional/test_s3.py:20303: in test_create_bucket_bucket_owner_preferred
    _test_object_ownership_bucket_owner_preferred(get_alt_client(), bucket, bucket_owner)
s3tests/functional/test_s3.py:20200: in _test_object_ownership_bucket_owner_preferred
    client.put_object(Bucket=bucket, Key='put-object-no-acl')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_create_bucket_object_writer</summary>

**Test description**

> CreateBucket with ObjectOwnership=ObjectWriter; uploader retains ownership.

**Error stack trace** — `s3_core` — `failed` — 10.124s

```pytb
s3tests/functional/test_s3.py:20315: in test_create_bucket_object_writer
    _test_object_ownership_object_writer(get_alt_client(), bucket, bucket_owner)
s3tests/functional/test_s3.py:20235: in _test_object_ownership_object_writer
    client.put_object(Bucket=bucket, Key='put-object-no-acl')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_put_bucket_ownership_bucket_owner_enforced</summary>

**Test description**

> PutBucketOwnershipControls flipping a bucket to BucketOwnerEnforced disables ACLs.

**Error stack trace** — `s3_core` — `failed` — 12.311s

```pytb
s3tests/functional/test_s3.py:20340: in test_put_bucket_ownership_bucket_owner_enforced
    _test_object_ownership_bucket_owner_enforced(get_alt_client(), bucket, bucket_owner)
s3tests/functional/test_s3.py:20162: in _test_object_ownership_bucket_owner_enforced
    client.put_object(Bucket=bucket, Key='put-object-no-acl')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_put_bucket_ownership_bucket_owner_preferred</summary>

**Test description**

> PutBucketOwnershipControls to BucketOwnerPreferred.

**Error stack trace** — `s3_core` — `failed` — 9.557s

```pytb
s3tests/functional/test_s3.py:20353: in test_put_bucket_ownership_bucket_owner_preferred
    _test_object_ownership_bucket_owner_preferred(get_alt_client(), bucket, bucket_owner)
s3tests/functional/test_s3.py:20200: in _test_object_ownership_bucket_owner_preferred
    client.put_object(Bucket=bucket, Key='put-object-no-acl')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_put_bucket_ownership_object_writer</summary>

**Test description**

> PutBucketOwnershipControls to ObjectWriter.

**Error stack trace** — `s3_core` — `failed` — 6.671s

```pytb
s3tests/functional/test_s3.py:20366: in test_put_bucket_ownership_object_writer
    _test_object_ownership_object_writer(get_alt_client(), bucket, bucket_owner)
s3tests/functional/test_s3.py:20235: in _test_object_ownership_object_writer
    client.put_object(Bucket=bucket, Key='put-object-no-acl')
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (InternalError) when calling the PutObject operation (reached max retries: 4): InternalError
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_head_object_404_with_policy_prefix</summary>

**Test description**

> HeadObject on a missing key under a policy-restricted prefix; expects 404 (not 403 — the policy doesn't leak existence).

**Error stack trace** — `s3_core` — `failed` — 1.77s

```pytb
s3tests/functional/test_s3.py:20410: in test_head_object_404_with_policy_prefix
    assert 403 == _get_status(e.response)
E   AssertionError: assert 403 == 404
E    +  where 404 = _get_status({'Error': {'Code': '404', 'Message': 'Not Found'}, 'ResponseMetadata': {'HTTPHeaders': {'content-length': '9', 'conten...ode': 404, 'HostId': '1783516160884964813-f26df963e45d99d2', 'RequestId': '1783516160884964813-f26df963e45d99d2', ...}})
E    +    where {'Error': {'Code': '404', 'Message': 'Not Found'}, 'ResponseMetadata': {'HTTPHeaders': {'content-length': '9', 'conten...ode': 404, 'HostId': '1783516160884964813-f26df963e45d99d2', 'RequestId': '1783516160884964813-f26df963e45d99d2', ...}} = ClientError('An error occurred (404) when calling the HeadObject operation: Not Found').response
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_part_enc[sse-s3-sse-kms-STANDARD-STANDARD-8388608]</summary>

**Test description**

> Parametrized UploadPartCopy matrix across (source_mode_key, dest_mode_key, source_storage_class, dest_storage_class, obj_size); verifies that encryption-mode transitions during copy preserve bytes.

**Error stack trace** — `encryption` — `failed` — 2.472s

```pytb
s3tests/functional/test_s3.py:20708: in test_copy_part_enc
    _test_copy_part_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20536: in _test_copy_part_enc
    response = client.create_multipart_upload(Bucket=dest_bucket_name, Key='testobj2', **upload_args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the CreateMultipartUpload operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_part_enc[sse-c-sse-kms-STANDARD-STANDARD-8388608]</summary>

**Test description**

> Parametrized UploadPartCopy matrix across (source_mode_key, dest_mode_key, source_storage_class, dest_storage_class, obj_size); verifies that encryption-mode transitions during copy preserve bytes.

**Error stack trace** — `encryption` — `failed` — 2.718s

```pytb
s3tests/functional/test_s3.py:20708: in test_copy_part_enc
    _test_copy_part_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20536: in _test_copy_part_enc
    response = client.create_multipart_upload(Bucket=dest_bucket_name, Key='testobj2', **upload_args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the CreateMultipartUpload operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_part_enc[sse-kms-sse-s3-STANDARD-STANDARD-8388608]</summary>

**Test description**

> Parametrized UploadPartCopy matrix across (source_mode_key, dest_mode_key, source_storage_class, dest_storage_class, obj_size); verifies that encryption-mode transitions during copy preserve bytes.

**Error stack trace** — `encryption` — `failed` — 1.866s

```pytb
s3tests/functional/test_s3.py:20708: in test_copy_part_enc
    _test_copy_part_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20528: in _test_copy_part_enc
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data, **args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_part_enc[sse-kms-sse-c-STANDARD-STANDARD-8388608]</summary>

**Test description**

> Parametrized UploadPartCopy matrix across (source_mode_key, dest_mode_key, source_storage_class, dest_storage_class, obj_size); verifies that encryption-mode transitions during copy preserve bytes.

**Error stack trace** — `encryption` — `failed` — 1.903s

```pytb
s3tests/functional/test_s3.py:20708: in test_copy_part_enc
    _test_copy_part_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20528: in _test_copy_part_enc
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data, **args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_part_enc[sse-kms-sse-kms-STANDARD-STANDARD-8388608]</summary>

**Test description**

> Parametrized UploadPartCopy matrix across (source_mode_key, dest_mode_key, source_storage_class, dest_storage_class, obj_size); verifies that encryption-mode transitions during copy preserve bytes.

**Error stack trace** — `encryption` — `failed` — 9.357s

```pytb
s3tests/functional/test_s3.py:20708: in test_copy_part_enc
    _test_copy_part_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20528: in _test_copy_part_enc
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data, **args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-s3-sse-kms-STANDARD-STANDARD-1]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 2.429s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20506: in _test_copy_enc
    response = client.copy_object(Bucket=dest_bucket_name, Key='testobj2', CopySource={'Bucket': bucket_name, 'Key': 'testobj'}, **copy_args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the CopyObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-s3-sse-kms-STANDARD-STANDARD-1024]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 2.353s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20506: in _test_copy_enc
    response = client.copy_object(Bucket=dest_bucket_name, Key='testobj2', CopySource={'Bucket': bucket_name, 'Key': 'testobj'}, **copy_args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the CopyObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-s3-sse-kms-STANDARD-STANDARD-1048576]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 2.507s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20506: in _test_copy_enc
    response = client.copy_object(Bucket=dest_bucket_name, Key='testobj2', CopySource={'Bucket': bucket_name, 'Key': 'testobj'}, **copy_args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the CopyObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-s3-sse-kms-STANDARD-STANDARD-8388608]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 2.616s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20506: in _test_copy_enc
    response = client.copy_object(Bucket=dest_bucket_name, Key='testobj2', CopySource={'Bucket': bucket_name, 'Key': 'testobj'}, **copy_args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the CopyObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-c-sse-kms-STANDARD-STANDARD-1]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 2.151s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20506: in _test_copy_enc
    response = client.copy_object(Bucket=dest_bucket_name, Key='testobj2', CopySource={'Bucket': bucket_name, 'Key': 'testobj'}, **copy_args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the CopyObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-c-sse-kms-STANDARD-STANDARD-1024]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 2.248s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20506: in _test_copy_enc
    response = client.copy_object(Bucket=dest_bucket_name, Key='testobj2', CopySource={'Bucket': bucket_name, 'Key': 'testobj'}, **copy_args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the CopyObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-c-sse-kms-STANDARD-STANDARD-1048576]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 2.459s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20506: in _test_copy_enc
    response = client.copy_object(Bucket=dest_bucket_name, Key='testobj2', CopySource={'Bucket': bucket_name, 'Key': 'testobj'}, **copy_args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the CopyObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-c-sse-kms-STANDARD-STANDARD-8388608]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 11.178s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20506: in _test_copy_enc
    response = client.copy_object(Bucket=dest_bucket_name, Key='testobj2', CopySource={'Bucket': bucket_name, 'Key': 'testobj'}, **copy_args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the CopyObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-kms-sse-s3-STANDARD-STANDARD-1]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 4.034s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20497: in _test_copy_enc
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data, **args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-kms-sse-s3-STANDARD-STANDARD-1024]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 1.487s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20497: in _test_copy_enc
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data, **args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-kms-sse-s3-STANDARD-STANDARD-1048576]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 1.408s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20497: in _test_copy_enc
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data, **args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-kms-sse-s3-STANDARD-STANDARD-8388608]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 9.894s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20497: in _test_copy_enc
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data, **args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-kms-sse-c-STANDARD-STANDARD-1]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 1.484s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20497: in _test_copy_enc
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data, **args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-kms-sse-c-STANDARD-STANDARD-1024]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 1.574s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20497: in _test_copy_enc
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data, **args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-kms-sse-c-STANDARD-STANDARD-1048576]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 1.593s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20497: in _test_copy_enc
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data, **args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-kms-sse-c-STANDARD-STANDARD-8388608]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 9.097s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20497: in _test_copy_enc
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data, **args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-kms-sse-kms-STANDARD-STANDARD-1]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 1.435s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20497: in _test_copy_enc
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data, **args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-kms-sse-kms-STANDARD-STANDARD-1024]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 1.338s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20497: in _test_copy_enc
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data, **args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-kms-sse-kms-STANDARD-STANDARD-1048576]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 9.492s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20497: in _test_copy_enc
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data, **args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_copy_enc[sse-kms-sse-kms-STANDARD-STANDARD-8388608]</summary>

**Test description**

> Parametrized CopyObject matrix across encryption modes and storage classes; verifies same behavior at the single-part copy level.

**Error stack trace** — `encryption` — `failed` — 9.883s

```pytb
s3tests/functional/test_s3.py:20753: in test_copy_enc
    _test_copy_enc(obj_size, source_mode_key, dest_mode_key, source_storage_class, dest_storage_class)
s3tests/functional/test_s3.py:20497: in _test_copy_enc
    response = client.put_object(Bucket=bucket_name, Key='testobj', Body=data, **args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.errorfactory.InvalidRequest: An error occurred (InvalidRequest) when calling the PutObject operation: InvalidRequest
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_lock_changing_mode_from_governance_with_bypass</summary>

**Test description**

> GOVERNANCE → COMPLIANCE upgrade is allowed when BypassGovernanceRetention=True is supplied.

**Error stack trace** — `s3_core` — `error` — 10.94s

```pytb
s3tests/functional/__init__.py:349: in setup_teardown
    teardown()
s3tests/functional/__init__.py:318: in teardown
    nuke_prefixed_buckets(prefix=prefix)
s3tests/functional/__init__.py:159: in nuke_prefixed_buckets
    raise err
s3tests/functional/__init__.py:150: in nuke_prefixed_buckets
    nuke_bucket(client, bucket_name)
s3tests/functional/__init__.py:139: in nuke_bucket
    client.delete_bucket(Bucket=bucket)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (BucketNotEmpty) when calling the DeleteBucket operation: BucketNotEmpty
```

</details>

<details markdown="1">
<summary>s3tests/functional/test_s3.py::test_object_lock_changing_mode_from_compliance</summary>

**Test description**

> COMPLIANCE → GOVERNANCE downgrade is forbidden even with bypass; expects 403 AccessDenied.

**Error stack trace** — `s3_core` — `error` — 10.845s

```pytb
s3tests/functional/__init__.py:349: in setup_teardown
    teardown()
s3tests/functional/__init__.py:318: in teardown
    nuke_prefixed_buckets(prefix=prefix)
s3tests/functional/__init__.py:159: in nuke_prefixed_buckets
    raise err
s3tests/functional/__init__.py:150: in nuke_prefixed_buckets
    nuke_bucket(client, bucket_name)
s3tests/functional/__init__.py:139: in nuke_bucket
    client.delete_bucket(Bucket=bucket)
../.venv/lib/python3.14/site-packages/botocore/client.py:602: in _api_call
    return self._make_api_call(operation_name, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/context.py:123: in wrapper
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
../.venv/lib/python3.14/site-packages/botocore/client.py:1078: in _make_api_call
    raise error_class(parsed_response, operation_name)
E   botocore.exceptions.ClientError: An error occurred (BucketNotEmpty) when calling the DeleteBucket operation: BucketNotEmpty
```

</details>
