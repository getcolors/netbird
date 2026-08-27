#!/usr/bin/env python3
"""Minimal SigV4 client for the backup bucket.

This exists because the distribution's rclone is too old for R2 — every upload
returns 501 NotImplemented regardless of flags — and pinning a package version
of a tool that is only needed for four object operations is a worse dependency
than four object operations. Uses only the standard library, so it works on any
host that has python3.

    s3.py put   <bucket> <key> <file>
    s3.py get   <bucket> <key> <file>
    s3.py delete <bucket> <key>
    s3.py list  <bucket> [prefix]      one key per line
    s3.py size  <bucket> <key>         bytes, or "missing"

Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, the endpoint
from S3_ENDPOINT, and the region from S3_REGION.
"""
import datetime
import hashlib
import hmac
import os
import re
import sys
import urllib.error
import urllib.request

ENDPOINT = os.environ["S3_ENDPOINT"].rstrip("/")
REGION = os.environ.get("S3_REGION", "auto")
AK = os.environ["AWS_ACCESS_KEY_ID"]
SK = os.environ["AWS_SECRET_ACCESS_KEY"]
HOST = re.sub(r"^https?://", "", ENDPOINT)


def _sign(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def request(method, path, query="", body=b""):
    now = datetime.datetime.now(datetime.timezone.utc)
    amz, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    payload = hashlib.sha256(body).hexdigest()
    canonical = (
        f"{method}\n{path}\n{query}\n"
        f"host:{HOST}\nx-amz-content-sha256:{payload}\nx-amz-date:{amz}\n\n"
        f"host;x-amz-content-sha256;x-amz-date\n{payload}"
    )
    scope = f"{day}/{REGION}/s3/aws4_request"
    to_sign = (
        "AWS4-HMAC-SHA256\n"
        f"{amz}\n{scope}\n" + hashlib.sha256(canonical.encode()).hexdigest()
    )
    k = _sign(_sign(_sign(_sign(("AWS4" + SK).encode(), day), REGION), "s3"),
              "aws4_request")
    signature = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    headers = {
        "Authorization": (
            f"AWS4-HMAC-SHA256 Credential={AK}/{scope}, "
            "SignedHeaders=host;x-amz-content-sha256;x-amz-date, "
            f"Signature={signature}"
        ),
        "x-amz-date": amz,
        "x-amz-content-sha256": payload,
    }
    url = f"https://{HOST}{path}" + (f"?{query}" if query else "")
    req = urllib.request.Request(
        url, data=(body if method in ("PUT", "POST") else None),
        method=method, headers=headers)
    return urllib.request.urlopen(req, timeout=300)


def main(argv):
    op = argv[1]
    bucket = argv[2]
    try:
        if op == "put":
            with open(argv[4], "rb") as fh:
                request("PUT", f"/{bucket}/{argv[3]}", body=fh.read())
        elif op == "get":
            with request("GET", f"/{bucket}/{argv[3]}") as resp, \
                    open(argv[4], "wb") as fh:
                fh.write(resp.read())
        elif op == "delete":
            request("DELETE", f"/{bucket}/{argv[3]}")
        elif op == "list":
            prefix = argv[3] if len(argv) > 3 else ""
            token, seen = None, []
            while True:
                q = "list-type=2" + (f"&prefix={prefix}" if prefix else "")
                if token:
                    q += f"&continuation-token={urllib.parse.quote(token, safe='')}"
                body = request("GET", f"/{bucket}", query=q).read().decode()
                seen += re.findall(r"<Key>([^<]+)</Key>", body)
                m = re.search(r"<NextContinuationToken>([^<]+)<", body)
                if not m:
                    break
                token = m.group(1)
            print("\n".join(seen))
        elif op == "size":
            try:
                resp = request("HEAD", f"/{bucket}/{argv[3]}")
                print(resp.headers.get("Content-Length", "0"))
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    print("missing")
                    return 0
                raise
        else:
            print(f"unknown operation {op}", file=sys.stderr)
            return 2
    except urllib.error.HTTPError as exc:
        print(f"s3 {op} failed: HTTP {exc.code} {exc.read()[:200]!r}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    import urllib.parse  # noqa: F401  (used by the list continuation token)
    sys.exit(main(sys.argv))
