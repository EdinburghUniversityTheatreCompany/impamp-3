"""Generate SigV4 reference vectors with botocore, to test our TS impl against."""

import datetime as _dt
import json

import botocore.auth
from botocore.auth import S3SigV4Auth, S3SigV4QueryAuth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

FROZEN_DT = _dt.datetime(2026, 8, 14, 10, 11, 12)


class _FrozenDateTime(_dt.datetime):
    @classmethod
    def utcnow(cls):
        return FROZEN_DT

    @classmethod
    def now(cls, tz=None):
        return FROZEN_DT if tz is None else FROZEN_DT.replace(tzinfo=tz)


class _FrozenDateTimeModule:
    datetime = _FrozenDateTime
    timedelta = _dt.timedelta


botocore.auth.datetime = _FrozenDateTimeModule
# botocore >= 1.36 stamps the signing time through this helper.
botocore.auth.get_current_datetime = lambda: FROZEN_DT

CREDS = Credentials("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
REGION = "eu-central-2"
SERVICE = "s3"
FROZEN = "20260814T101112Z"


class FrozenSigV4Query(S3SigV4QueryAuth):
    def _get_timestamp(self):
        return FROZEN


class FrozenSigV4(S3SigV4Auth):
    def _get_timestamp(self):
        return FROZEN


def freeze(signer):
    # botocore stamps the date from the request context; force ours.
    orig = signer.add_auth

    def add_auth(request):
        request.context["timestamp"] = FROZEN
        return orig(request)

    signer.add_auth = add_auth
    return signer


def presign(method, url, expires, headers=None):
    signer = S3SigV4QueryAuth(CREDS, SERVICE, REGION, expires=expires)
    request = AWSRequest(method=method, url=url, headers=headers or {})
    request.context["timestamp"] = FROZEN
    signer.add_auth(request)
    return request.url


def header_sign(method, url, payload_hash, headers=None):
    signer = S3SigV4Auth(CREDS, SERVICE, REGION)
    request = AWSRequest(method=method, url=url, headers=headers or {})
    request.context["timestamp"] = FROZEN
    request.context["payload_signing_enabled"] = False
    request.headers.add_header("x-amz-content-sha256", payload_hash)
    signer.add_auth(request)
    return dict(request.headers.items())


ENDPOINT = "https://s3.eu-central-2.wasabisys.com"
BUCKET = "impamp-audio"

vectors = {
    "region": REGION,
    "service": SERVICE,
    "timestamp": FROZEN,
    "accessKeyId": CREDS.access_key,
    "secretAccessKey": CREDS.secret_key,
    "endpoint": ENDPOINT,
    "bucket": BUCKET,
    "presignedGet": presign("GET", f"{ENDPOINT}/{BUCKET}/audio/ab/abc123.wav", 900),
    "presignedPut": presign("PUT", f"{ENDPOINT}/{BUCKET}/audio/ab/abc123.wav", 300),
    "presignedGetWithSpaceAndUnicode": presign(
        "GET", f"{ENDPOINT}/{BUCKET}/audio/pad%20one/caf%C3%A9%20%281%29.wav", 900
    ),
    "presignedGetWithQuery": presign(
        "GET",
        f"{ENDPOINT}/{BUCKET}/audio/ab/abc123.wav?response-content-type=audio%2Fwav",
        900,
    ),
    "headHeaders": header_sign(
        "HEAD",
        f"{ENDPOINT}/{BUCKET}/audio/ab/abc123.wav",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ),
    "deleteHeaders": header_sign(
        "DELETE",
        f"{ENDPOINT}/{BUCKET}/audio/ab/abc123.wav",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ),
}

print(json.dumps(vectors, indent=2, sort_keys=True))
