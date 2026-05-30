"""
Archive → restore round-trip for every archivable entity.

Regression for the feature-completeness gap: CRM leads/deals and Planning
projects/tasks could be archived (which hides them from every list) but had no
way back — no per-module unarchive endpoint and no registration in the generic
Archives router. This proves each can now be archived AND restored, and that
while archived it surfaces on the Archives page.
"""
import pytest


def _ids(c, path):
    return {r["id"] for r in c.get(path).json()}


def _archived_ids(c, module):
    return {r["id"] for r in c.get("/api/archives/", params={"module": module}).json()}


def _roundtrip(c, *, create_path, create_body, slug, list_path, module):
    r = c.post(create_path, json=create_body)
    assert r.status_code in (200, 201), r.text
    eid = r.json()["id"]
    assert eid in _ids(c, list_path)                       # visible while active

    assert c.patch(f"{create_path}/{eid}/archive").status_code == 200
    assert eid not in _ids(c, list_path)                   # archive hides it
    assert eid in _archived_ids(c, module)                 # shows on Archives page

    assert c.patch(f"/api/archives/{module}/{eid}/unarchive").status_code == 200
    assert eid in _ids(c, list_path)                       # restored
    assert eid not in _archived_ids(c, module)             # gone from Archives


def test_crm_lead_archive_restore(make_client):
    c = make_client("superadmin")
    _roundtrip(c, create_path="/api/crm/leads", create_body={"name": "Lead R"},
               slug="leads", list_path="/api/crm/leads", module="crm_leads")


def test_crm_deal_archive_restore(make_client):
    c = make_client("superadmin")
    _roundtrip(c, create_path="/api/crm/deals", create_body={"title": "Deal R"},
               slug="deals", list_path="/api/crm/deals", module="crm_deals")


def test_planning_project_archive_restore(make_client):
    c = make_client("superadmin")
    _roundtrip(c, create_path="/api/planning/projects", create_body={"name": "Proj R"},
               slug="projects", list_path="/api/planning/projects", module="planning_projects")


def test_planning_task_archive_restore(make_client):
    c = make_client("superadmin")
    proj = c.post("/api/planning/projects", json={"name": "Task Host"})
    assert proj.status_code in (200, 201), proj.text
    pid = proj.json()["id"]
    _roundtrip(c, create_path="/api/planning/tasks",
               create_body={"name": "Task R", "project_id": pid},
               slug="tasks", list_path="/api/planning/tasks", module="planning_tasks")
