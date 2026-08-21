"""
Bank accounts — where money actually sits.

Cash drawers already answer this for notes in a till. A bank transfer had
nowhere to say which account it landed in, so every bank movement piled into one
ledger line and no balance could be reconciled against a statement.

Each account gets its own code in the chart, created under whatever the `bank`
role points at — 512 بنوك on Lebanon's plan, 1000 Cash & Bank on the default one.
That is what makes a per-account balance possible at all: the ledger has to have
somewhere separate to put it.

Deleting is deliberately absent. An account is what historical entries point at,
so one that has seen a movement is archived, never removed.
"""
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, validator

import accounting
import branch_access
import currency as currency_mod
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now, money

router = APIRouter()


class BankAccountBody(BaseModel):
    name:            str
    bank_name:       Optional[str] = None
    account_number:  Optional[str] = None
    iban:            Optional[str] = None
    swift:           Optional[str] = None
    currency:        str = "USD"
    opening_balance: float = 0
    notes:           Optional[str] = None
    branch_id:       Optional[int] = None

    @validator("name")
    def _name_required(cls, v):
        if not (v or "").strip():
            raise ValueError("A name is required — what the staff call this account.")
        return v.strip()

    @validator("currency")
    def _known_currency(cls, v):
        if not currency_mod.is_supported(v):
            raise ValueError(
                "Currency must be one of: " + ", ".join(currency_mod.SUPPORTED))
        return (v or "USD").upper()


def _next_account_code(db) -> str:
    """A free code for a new bank account, under the bank role's own heading.

    Numbering beneath the parent is how both charts expect sub-accounts to be
    opened: 5121, 5122 under 512 بنوك. Falls back to a suffixed code if that
    range fills up, which for a business's bank accounts it will not.
    """
    parent = accounting.code(db, "bank")
    for n in range(1, 100):
        candidate = f"{parent}{n}"
        exists = db.execute(
            "SELECT 1 FROM chart_of_accounts WHERE code = ?", (candidate,)).fetchone()
        if not exists:
            return candidate
    raise HTTPException(400, "No free account code under the bank heading.")


def _ensure_chart_account(db, name: str, ccy: str) -> str:
    """Open a ledger account for this bank account and return its code."""
    acct_code = _next_account_code(db)
    parent = accounting.code(db, "bank")
    parent_row = db.execute(
        "SELECT type, subtype, normal_balance FROM chart_of_accounts WHERE code = ?",
        (parent,)).fetchone()
    db.execute(
        "INSERT INTO chart_of_accounts "
        "(code, name, type, subtype, normal_balance, parent_code, is_system, "
        " is_active, is_postable, created_at) "
        "VALUES (?,?,?,?,?,?,0,1,1,?)",
        (acct_code, f"{name} ({ccy})",
         parent_row["type"] if parent_row else "Asset",
         parent_row["subtype"] if parent_row else "Current Asset",
         parent_row["normal_balance"] if parent_row else "debit",
         parent, _now()))
    return acct_code


def _balance(db, row) -> float:
    """What the ledger says this account holds, opening balance included."""
    if not row["account_code"]:
        return float(row["opening_balance"] or 0)
    bal = db.execute(
        "SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS bal "
        "FROM journal_entry_lines l "
        "JOIN journal_entries je ON je.id = l.journal_entry_id "
        "JOIN chart_of_accounts a ON a.id = l.account_id "
        "WHERE a.code = ? AND je.status = 'posted'",
        (row["account_code"],)).fetchone()
    return money(float(row["opening_balance"] or 0) + float(bal["bal"] or 0))


@router.get("/")
def list_bank_accounts(include_archived: bool = False,
                       user=Depends(require_perm("finance", "view")),
                       db: sqlite3.Connection = Depends(get_db)):
    where = "" if include_archived else " WHERE archived_at IS NULL"
    rows = db.execute(
        f"SELECT * FROM bank_accounts{where} ORDER BY is_active DESC, name").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["balance"] = _balance(db, r)
        out.append(d)
    return out


@router.post("/")
def create_bank_account(data: BankAccountBody,
                        user=Depends(require_perm("finance", "create")),
                        db: sqlite3.Connection = Depends(get_db)):
    branch_id = branch_access.resolve_branch_id(user, db, data.branch_id)
    acct_code = _ensure_chart_account(db, data.name, data.currency)
    cur = db.execute(
        "INSERT INTO bank_accounts "
        "(name, bank_name, account_number, iban, swift, currency, account_code, "
        " opening_balance, is_active, notes, branch_id, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,1,?,?,?)",
        (data.name, data.bank_name, data.account_number, data.iban, data.swift,
         data.currency, acct_code, data.opening_balance, data.notes, branch_id,
         _now()))
    bank_id = cur.lastrowid
    log_action(db, user, "create", "bank_account", bank_id, data.name,
               {"currency": data.currency, "account_code": acct_code})
    db.commit()
    return {"id": bank_id, "account_code": acct_code,
            "message": "Bank account added"}


@router.put("/{bank_id}")
def update_bank_account(bank_id: int, data: BankAccountBody,
                        user=Depends(require_perm("finance", "edit")),
                        db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM bank_accounts WHERE id=?", (bank_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Bank account not found")
    # The currency is not editable once movements exist: the ledger account
    # behind it holds amounts already converted at that currency's rates, and
    # re-labelling it would silently reinterpret every one of them.
    if (data.currency or "USD").upper() != (row["currency"] or "USD").upper():
        posted = db.execute(
            "SELECT COUNT(*) AS n FROM journal_entry_lines l "
            "JOIN chart_of_accounts a ON a.id = l.account_id "
            "WHERE a.code = ?", (row["account_code"],)).fetchone()["n"]
        if posted:
            raise HTTPException(
                400, "This account has movements, so its currency cannot be "
                     "changed. Open a new account in the other currency and "
                     "archive this one.")
    db.execute(
        "UPDATE bank_accounts SET name=?, bank_name=?, account_number=?, iban=?, "
        " swift=?, currency=?, opening_balance=?, notes=? WHERE id=?",
        (data.name, data.bank_name, data.account_number, data.iban, data.swift,
         data.currency, data.opening_balance, data.notes, bank_id))
    log_action(db, user, "update", "bank_account", bank_id, data.name)
    db.commit()
    return {"message": "Bank account updated"}


@router.patch("/{bank_id}/archive")
def archive_bank_account(bank_id: int,
                         user=Depends(require_perm("finance", "delete")),
                         db: sqlite3.Connection = Depends(get_db)):
    """Retire an account. Never deleted — it is what historical entries point at."""
    row = db.execute("SELECT name FROM bank_accounts WHERE id=?", (bank_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Bank account not found")
    db.execute("UPDATE bank_accounts SET archived_at=?, is_active=0 WHERE id=?",
               (_now(), bank_id))
    log_action(db, user, "archive", "bank_account", bank_id, row["name"])
    db.commit()
    return {"message": "Bank account archived"}


@router.patch("/{bank_id}/unarchive")
def unarchive_bank_account(bank_id: int,
                           user=Depends(require_perm("finance", "delete")),
                           db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT name FROM bank_accounts WHERE id=?", (bank_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Bank account not found")
    db.execute("UPDATE bank_accounts SET archived_at=NULL, is_active=1 WHERE id=?",
               (bank_id,))
    log_action(db, user, "unarchive", "bank_account", bank_id, row["name"])
    db.commit()
    return {"message": "Bank account restored"}
