#!/usr/bin/env python3
"""Authenticate as the Authentik-backed owner and print an access token.

This exists because a NetBird account is created by its first login, and the
account that matters here is the federated one. NetBird's embedded Dex issues
tokens for local users; an Authentik user reaches NetBird only by completing a
browser-shaped OAuth2 flow. Nothing in the API creates that user on its behalf:
`POST /api/users` makes a *local* user in the *local* account, and the admin
CLI only manages embedded-IdP identities.

So the flow is driven here instead, using Authentik's flow-executor API rather
than a browser. Two legs, and both matter:

  dashboard -> Dex        our own PKCE pair, redirect_uri /nb-auth
  Dex       -> Authentik  Dex's PKCE, redirect_uri /oauth2/callback

Relative redirects are resolved against the URL they came from — the Authentik
URLs carry `client_id=netbird`, so a substring test for the host picks the
wrong one — and any stage the chain lands on is driven, including the explicit
consent flow, which returns an already-resolved redirect once consent stands.

    federated-login.py <idp-id> <netbird-host> <authentik-host> <user> <pwfile>
"""
import base64
import hashlib
import http.cookiejar
import json
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

IDP, NB_HOST, AK_HOST, USER, PW_FILE = sys.argv[1:6]
NB, AK = f"https://{NB_HOST}", f"https://{AK_HOST}"
PW = open(PW_FILE).read().strip()
UA = {"User-Agent": "colors-netbird-bootstrap"}

jar = http.cookiejar.CookieJar()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_follow = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
_stop = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), _NoRedirect)


def get(url, follow=True, headers=None):
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    try:
        r = (_follow if follow else _stop).open(req, timeout=30)
        return r.getcode(), dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def post_json(url, payload):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={**UA, "Content-Type": "application/json", "Accept": "application/json"})
    try:
        r = _follow.open(req, timeout=30)
        return r.getcode(), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def die(msg):
    print(f"federated-login: {msg}", file=sys.stderr)
    sys.exit(1)


def location(headers):
    return headers.get("location") or headers.get("Location")


verifier = base64.urlsafe_b64encode(secrets.token_bytes(40)).decode().rstrip("=")
challenge = base64.urlsafe_b64encode(
    hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
query = urllib.parse.urlencode({
    "client_id": "netbird-dashboard", "response_type": "code",
    "scope": "openid profile email", "redirect_uri": f"{NB}/nb-auth",
    "state": secrets.token_hex(8), "nonce": secrets.token_hex(8),
    "code_challenge": challenge, "code_challenge_method": "S256"})

# Enter through the connector for this identity provider, not the local one.
_, headers, _ = get(f"{NB}/oauth2/auth/{IDP}?{query}", follow=False)
url = location(headers)
if not url or AK_HOST not in url:
    die(f"the Dex connector for {IDP} did not redirect to {AK_HOST}")

_, headers, _ = get(url, follow=False)
flow_url = location(headers)
if not flow_url:
    die("Authentik did not hand the request to a flow")
flow_url = urllib.parse.urljoin(url, flow_url)
parts = urllib.parse.urlparse(flow_url)
executor = (f"{parts.scheme}://{parts.netloc}/api/v3/flows/executor/"
            f"{parts.path.strip('/').split('/')[2]}/"
            f"?query={urllib.parse.quote(parts.query, safe='')}")

_, _, body = get(executor, headers={"Accept": "application/json"})
target = None
for payload in ({"uid_field": USER}, {"password": PW}):
    code, body = post_json(executor, payload)
    data = json.loads(body) if body else {}
    if code >= 400:
        die(f"the {list(payload)[0]} stage was rejected: {body[:200]!r}")
    if data.get("component") == "xak-flow-redirect":
        target = data.get("to")
        break
if not target:
    die("the authentication flow did not complete")
url = urllib.parse.urljoin(flow_url, target)

for _ in range(12):
    code, headers, _ = get(url, follow=False)
    nxt = location(headers)
    if nxt:
        url = urllib.parse.urljoin(url, nxt)
        if "/nb-auth" in url:
            break
        continue
    parts = urllib.parse.urlparse(url)
    if "/if/flow/" not in parts.path:
        break
    ex = (f"{parts.scheme}://{parts.netloc}/api/v3/flows/executor/"
          f"{parts.path.strip('/').split('/')[2]}/"
          f"?query={urllib.parse.quote(parts.query, safe='')}")
    _, _, b = get(ex, headers={"Accept": "application/json"})
    stage = json.loads(b)
    # Consent already granted: follow it rather than submitting a stage that is
    # no longer being asked for, which answers with an HTML error page.
    if stage.get("component") == "xak-flow-redirect" and stage.get("to"):
        url = urllib.parse.urljoin(url, stage["to"])
        continue
    code, b = post_json(ex, {})
    try:
        stage = json.loads(b) if b else {}
    except json.JSONDecodeError:
        die(f"a flow stage answered with HTML rather than JSON: {b[:160]!r}")
    if not stage.get("to"):
        die(f"a flow stage did not resolve: {b[:200]!r}")
    url = urllib.parse.urljoin(url, stage["to"])

auth_code = (urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
             .get("code") or [None])[0]
if not auth_code:
    die("no authorization code arrived at /nb-auth")

token_body = urllib.parse.urlencode({
    "grant_type": "authorization_code", "code": auth_code,
    "redirect_uri": f"{NB}/nb-auth", "client_id": "netbird-dashboard",
    "code_verifier": verifier}).encode()
req = urllib.request.Request(
    f"{NB}/oauth2/token", data=token_body, method="POST",
    headers={**UA, "Content-Type": "application/x-www-form-urlencoded"})
try:
    tokens = json.loads(_follow.open(req, timeout=30).read())
except urllib.error.HTTPError as e:
    die(f"the token exchange failed: {e.code} {e.read()[:200]!r}")

token = tokens.get("access_token") or tokens.get("id_token")
if not token:
    die("the token response carried no usable token")
print(token)
