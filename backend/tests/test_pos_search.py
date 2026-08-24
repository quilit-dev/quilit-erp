"""Finding an item at the till.

A cashier types the words they can see on the packet, in whatever order they
come to mind. Matching the whole phrase as one string meant "blue shirt" found
nothing when the item was BLUE COTTON SHIRT, because the words are not
adjacent — which is most of what "the search does not work" meant.

The scanner is a separate path and must stay exact: the register adds a lone
result straight to the cart, so a scan that returns two rows would put the
wrong thing in it.
"""
import pytest as _pytest

pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


@_pytest.fixture
def shelf(client):
    """A few items with the shapes that actually break search."""
    for it in (
        {"name": "Blue Cotton Shirt", "category": "Apparel",
         "barcode": "6291041500213", "quantity": 10, "unit_cost": 5,
         "sale_price": 20},
        {"name": "Nescafe Gold 200g", "category": "Beverages",
         "barcode": "7613039499726", "quantity": 40, "unit_cost": 4,
         "sale_price": 9},
        {"name": "قميص قطن أزرق", "category": "Apparel",
         "barcode": "6291041500220", "quantity": 5, "unit_cost": 5,
         "sale_price": 20},
        {"name": "Olive Oil 1L", "category": "Grocery", "barcode": "",
         "quantity": 12, "unit_cost": 6, "sale_price": 14},
    ):
        r = client.post("/api/inventory/", json=it)
        assert r.status_code == 200, r.text
    return client


def _find(client, term):
    r = client.get("/api/pos/products", params={"search": term})
    assert r.status_code == 200, r.text
    return [x["name"] for x in r.json()]


# ── Typing words ─────────────────────────────────────────────────────────────

def test_one_word_of_the_name(shelf):
    assert "Blue Cotton Shirt" in _find(shelf, "blue")


def test_a_word_from_the_middle_or_end(shelf):
    assert "Blue Cotton Shirt" in _find(shelf, "shirt")


def test_two_words_that_are_not_next_to_each_other(shelf):
    """The one that broke. The item is BLUE COTTON SHIRT and nobody types the
    word cotton."""
    assert "Blue Cotton Shirt" in _find(shelf, "blue shirt")


def test_the_words_in_the_wrong_order(shelf):
    assert "Blue Cotton Shirt" in _find(shelf, "shirt blue")


def test_a_brand_and_a_size(shelf):
    assert "Nescafe Gold 200g" in _find(shelf, "nescafe 200")


def test_case_does_not_matter(shelf):
    assert _find(shelf, "BLUE SHIRT") == _find(shelf, "blue shirt")


def test_stray_spaces_do_not_matter(shelf):
    """A scanner that appends a space, or a thumb on the spacebar."""
    assert "Blue Cotton Shirt" in _find(shelf, "  blue  ")
    assert "Blue Cotton Shirt" in _find(shelf, "blue   shirt")


def test_an_arabic_name(shelf):
    assert any("قميص" in n for n in _find(shelf, "قميص"))


def test_the_category(shelf):
    assert len(_find(shelf, "Apparel")) == 2


def test_an_item_with_no_barcode_is_findable(shelf):
    """Loose goods are the ones a cashier cannot scan, so search is the only
    way to reach them."""
    assert "Olive Oil 1L" in _find(shelf, "olive")


def test_a_word_that_matches_nothing_returns_nothing(shelf):
    assert _find(shelf, "bicycle") == []


def test_every_word_has_to_match(shelf):
    """Otherwise the search widens as you type, which is backwards."""
    assert _find(shelf, "blue bicycle") == []


# ── Barcodes ─────────────────────────────────────────────────────────────────

def test_a_scanned_barcode_returns_that_item_alone(shelf):
    """The register adds a lone result straight to the cart. Two rows here and
    it adds the wrong one."""
    assert _find(shelf, "6291041500213") == ["Blue Cotton Shirt"]


def test_a_barcode_wins_even_when_it_would_match_others_loosely(shelf):
    """6291041500213 and 6291041500220 share a long prefix. A scan of the first
    must not offer the second."""
    assert _find(shelf, "6291041500220") == ["قميص قطن أزرق"]


def test_part_of_a_barcode_still_finds_it(shelf):
    """The digits still legible on a damaged label."""
    assert "Blue Cotton Shirt" in _find(shelf, "1500213")


def test_a_shared_barcode_prefix_offers_both(shelf):
    """Typed, not scanned — so the cashier chooses."""
    assert len(_find(shelf, "629104")) == 2


# ── Ordering ─────────────────────────────────────────────────────────────────

def test_the_best_match_comes_first(client):
    """Enter acts on the top tile, so what the cashier meant has to be it."""
    for name in ("Water Bottle 1L", "Sparkling Water", "Water"):
        client.post("/api/inventory/", json={
            "name": name, "category": "Drinks", "quantity": 5,
            "unit_cost": 1, "sale_price": 2})

    names = _find(client, "water")

    assert names[0] == "Water", names


def test_browsing_with_no_search_still_leads_with_unscannable_goods(shelf):
    """Nothing typed: the grid is for tapping, and the items that need tapping
    are the ones with no barcode."""
    rows = shelf.get("/api/pos/products").json()

    assert rows[0]["name"] == "Olive Oil 1L"
