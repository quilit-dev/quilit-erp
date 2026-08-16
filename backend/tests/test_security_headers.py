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


def test_the_manual_relaxes_inline_scripts_and_nothing_else():
    """/manual/ is the one path allowed inline scripts. Verify the blast radius.

    MkDocs Material bootstraps from an inline <script>; blocked, it takes the
    search, the theme toggle and the audience tabs with it. So that one
    directive is relaxed for the manual's own static pages — and it must stay
    the *only* difference. If a later edit widens the manual policy (a CDN in
    script-src, a loosened connect-src) this fails, and if someone applies the
    manual's policy to the app it fails too.
    """
    import main

    app, manual = main._CSP_APP.decode(), main._CSP_MANUAL.decode()

    def directives(csp):
        return {d.strip().split(" ")[0]: d.strip() for d in csp.split(";") if d.strip()}

    a, m = directives(app), directives(manual)

    assert a["script-src"] == "script-src 'self'", \
        "the app itself must never allow inline scripts — the SPA has none"
    assert m["script-src"] == "script-src 'self' 'unsafe-inline'"
    assert "http" not in manual, "no third-party origin belongs in the manual's CSP"

    # Every other directive identical, and none dropped.
    assert set(a) == set(m)
    differing = {k for k in a if a[k] != m[k]}
    assert differing == {"script-src"}, f"unexpected CSP differences: {differing}"


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
