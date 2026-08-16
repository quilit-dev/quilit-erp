"""The user manual is served from the app itself, at /manual/.

Settings shows an "Open the user manual" button, and it has to be true. Two
ways it could quietly become a lie:

  1. The SPA catch-all swallows the manual. Every unknown path returns the
     app shell so client-side routing works — which means a manual page would
     return 200 and render the ERP. The reader clicks a link in the manual and
     lands back in the app with no error to explain it.

  2. The button appears when there is no manual. The manual is a separate
     build stage; an image built without it must 404 that path, because the UI
     probes it to decide whether to offer the button at all. A 200 shell reads
     as "the manual is here".

These test `resolve_static_path` rather than the route, because `static/` is
generated: CI has no frontend build, `_HAS_SPA` is False there and the route is
never registered. The rules are what matter, and they are the same either way.
"""
import os
import pytest

from main import resolve_static_path


@pytest.fixture
def site(tmp_path):
    """A static root shaped like a real deployment: SPA + built manual."""
    (tmp_path / "index.html").write_text("<!doctype html>SPA shell")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("//")
    manual = tmp_path / "manual"
    (manual / "sales" / "invoices").mkdir(parents=True)
    (manual / "index.html").write_text("<h1>User manual</h1>")
    (manual / "sitemap.xml").write_text("<urlset/>")
    (manual / "sales" / "invoices" / "index.html").write_text("<h1>Invoices</h1>")
    return str(tmp_path)


def test_manual_home_serves_the_manual_not_the_app(site):
    kind, value = resolve_static_path("manual/", site)
    assert kind == "file"
    assert "User manual" in open(value).read(), \
        "the manual's own index must win over the SPA shell"


def test_a_manual_page_is_a_directory_and_still_resolves(site):
    # MkDocs emits sales/invoices/index.html and links to it as "sales/invoices/".
    kind, value = resolve_static_path("manual/sales/invoices/", site)
    assert kind == "file"
    assert "Invoices" in open(value).read()


def test_manual_without_trailing_slash_redirects(site):
    # The manual's internal links are relative. Serving /manual as /manual/
    # would resolve all of them one directory too high.
    assert resolve_static_path("manual", site) == ("redirect", "/manual/")


def test_missing_manual_page_is_a_real_404(site):
    assert resolve_static_path("manual/does-not-exist/", site)[0] == "404"


def test_no_manual_built_means_404_not_the_app_shell(tmp_path):
    # An image built without the manual stage. The UI probes this path; if it
    # answered with the shell, the button would appear and lead nowhere.
    (tmp_path / "index.html").write_text("<!doctype html>SPA shell")

    assert resolve_static_path("manual/sitemap.xml", str(tmp_path))[0] == "404"
    assert resolve_static_path("manual/", str(tmp_path))[0] == "404"


def test_the_probe_target_exists_when_the_manual_does(site):
    # UserManualSection.jsx asks for sitemap.xml specifically: it is XML, so it
    # cannot be confused with an HTML fallback. MkDocs always emits it.
    kind, value = resolve_static_path("manual/sitemap.xml", site)
    assert kind == "file" and value.endswith("sitemap.xml")


def test_spa_routes_still_fall_through(site):
    # The whole point of the catch-all: client-side routes must reach the shell.
    assert resolve_static_path("invoices", site) == ("spa", None)
    assert resolve_static_path("", site) == ("spa", None)


def test_real_assets_are_still_served(site):
    kind, value = resolve_static_path("assets/app.js", site)
    assert kind == "file"
    # A missing asset stays a 404 rather than an HTML shell, so a stale bundle
    # reference fails loudly in the console instead of parsing as JavaScript.
    assert resolve_static_path("assets/gone.js", site)[0] == "404"


@pytest.mark.parametrize("attack", [
    "../secrets.txt",
    "manual/../../secrets.txt",
    "manual/../../../etc/passwd",
])
def test_path_traversal_escapes_nothing(attack, tmp_path):
    site = tmp_path / "static"
    (site / "manual").mkdir(parents=True)
    (site / "index.html").write_text("shell")
    (site / "manual" / "index.html").write_text("manual")
    (tmp_path / "secrets.txt").write_text("SECRET_KEY=hunter2")

    kind, value = resolve_static_path(attack, str(site))

    assert kind != "file", f"{attack} escaped the static root"
    if kind == "file":                       # defensive: never reached
        assert "hunter2" not in open(value).read()
