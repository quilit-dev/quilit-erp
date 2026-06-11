"""
Security response headers — every response must carry the hardening set
(SecurityHeadersMiddleware in main.py). These defend against MIME-sniffing,
clickjacking, and weaken the XSS blast radius (CSP).
"""


def test_security_headers_present(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.headers.get("x-content-type-options") == "nosniff"
    assert r.headers.get("x-frame-options") == "DENY"
    assert r.headers.get("referrer-policy") == "strict-origin-when-cross-origin"

    csp = r.headers.get("content-security-policy", "")
    assert "default-src 'self'" in csp
    assert "frame-ancestors 'none'" in csp     # clickjacking
    assert "object-src 'none'" in csp
    assert "script-src 'self'" in csp          # no inline scripts in the SPA build


def test_security_headers_on_api_404(client):
    """Headers must ride every response, including error paths."""
    r = client.get("/api/does-not-exist")
    assert r.status_code == 404
    assert r.headers.get("x-content-type-options") == "nosniff"
    assert "content-security-policy" in r.headers


def test_hsts_only_when_secure_cookies(client):
    """HSTS is gated on COOKIE_SECURE (HTTPS deploys). The test env runs with
    COOKIE_SECURE=false, so HSTS must be absent here — proving the gate works
    and that plain-HTTP self-hosted installs aren't sent HSTS."""
    import auth_utils
    r = client.get("/api/health")
    if auth_utils.COOKIE_SECURE:
        assert "strict-transport-security" in r.headers
    else:
        assert "strict-transport-security" not in r.headers
