"""
RQ worker entrypoint (Phase 4 — docs/SAAS_ARCHITECTURE.md §9).

Run alongside the app when JOBS=rq so enqueued jobs get processed:

    JOBS=rq REDIS_URL=redis://host:6379/0 python backend/worker.py

It imports the backend (so every ``@job`` registers), then drains the ``erp``
queue. Each job re-establishes its tenant schema before running (see
jobs.run_with_tenant). On Windows RQ cannot fork, so a SimpleWorker is used; on
Linux the default forking Worker is used.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    import redis
    from rq import Queue, Worker, SimpleWorker

    # Importing the app registers every router — and therefore every @job.
    import main  # noqa: F401

    conn = redis.Redis.from_url(os.environ.get("REDIS_URL", "redis://localhost:6379/0"))
    queue = Queue("erp", connection=conn)
    worker_cls = SimpleWorker if sys.platform == "win32" else Worker
    worker_cls([queue], connection=conn).work(with_scheduler=False)


if __name__ == "__main__":
    main()
