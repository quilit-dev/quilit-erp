"""Canonical Financial Health scoring shared by every ERP client.

The score is a business KPI, not a UI capability. Whether a user may open the
Inventory or Projects screen must not change the number shown to finance users.
The caller still decides whether the score itself may be returned, and supplies
only signals from modules licensed for this tenant.
"""
import math


def margin_percent(income: float, expenses: float) -> int:
    """Match JavaScript ``Math.round`` used by the existing ERP dashboard."""
    if income <= 0:
        return 0
    return math.floor((((income - expenses) / income) * 100) + 0.5)


def score(*, margin: float, unpaid_invoices: int = 0,
          overdue_invoices: int = 0, low_stock_alerts: int = 0,
          active_projects: int = 0, include_financial: bool = True,
          include_inventory: bool = False,
          include_projects: bool = False) -> int:
    """Return the ERP's established 0–100 weighted Financial Health score."""
    value = 50

    if include_financial:
        if margin > 20:
            value += 20
        elif margin > 0:
            value += 10
        elif margin < 0:
            value -= 15

        if unpaid_invoices == 0:
            value += 10
        elif unpaid_invoices > 5:
            value -= 10

        if overdue_invoices > 0:
            value -= min(20, overdue_invoices * 5)

    if include_inventory and low_stock_alerts == 0:
        value += 10
    if include_projects and active_projects > 0:
        value += 10

    return min(100, max(0, value))
