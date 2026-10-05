"""A discount on a whole invoice or quotation.

"10% off" or "$100 off" the document, rather than off one line. It is taken
off BEFORE VAT: the customer is charged tax on what they actually pay, which is
how a commercial discount works and what the VAT return expects.

The discount is spread across the lines in proportion to each line's net and
each line's share is stored on the line (`doc_discount`). That is what keeps
everything downstream right without knowing a header discount exists:

  * each line's VAT is computed on its own discounted net, so a document with
    lines at different rates is taxed correctly;
  * the revenue split, the VAT return by rate, and every report that reads a
    line's net (`qty x price - discount - doc_discount`) see the real figure;
  * the stored shares sum to the discount to the cent, so the lines still add
    up to the header.

Pure functions only; the routers decide what to store.
"""
from typing import List, Optional, Tuple

from utils import money

TYPES = ("amount", "percent")


def normalise(dtype: Optional[str], value) -> Tuple[Optional[str], float]:
    """(type, value) as stored, or (None, 0.0) for no discount.

    A percentage is held to 0..100. A negative or zero value means none ---
    a discount cannot be used to add a charge.
    """
    try:
        v = float(value or 0)
    except (TypeError, ValueError):
        v = 0.0
    if dtype not in TYPES or v <= 0:
        return None, 0.0
    if dtype == "percent":
        v = min(v, 100.0)
    return dtype, round(v, 4)


def total_for(net_sum: float, dtype: Optional[str], value: float) -> float:
    """How much comes off a document whose lines net to `net_sum`.

    A fixed amount larger than the document is capped at the document: an
    invoice can be brought to zero, never below it.
    """
    dtype, value = normalise(dtype, value)
    net_sum = max(0.0, float(net_sum or 0))
    if dtype is None or net_sum <= 0:
        return 0.0
    if dtype == "percent":
        return money(net_sum * value / 100.0)
    return money(min(value, net_sum))


def allocate(nets: List[float], total: float) -> List[float]:
    """Spread `total` across lines in proportion to their nets.

    Cent-rounded, and the rounding residue goes to the largest line, so the
    shares sum to `total` exactly. No line's share exceeds its own net.
    """
    total = money(total or 0)
    nets = [max(0.0, float(n or 0)) for n in nets]
    s = sum(nets)
    if total <= 0 or s <= 0:
        return [0.0] * len(nets)
    shares = [money(min(n, total * n / s)) for n in nets]
    residue = money(total - sum(shares))
    if residue and shares:
        i = max(range(len(nets)), key=lambda k: nets[k])
        shares[i] = money(min(nets[i], shares[i] + residue))
    return shares
