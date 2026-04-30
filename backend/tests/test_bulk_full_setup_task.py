from unittest.mock import patch

from app.tasks.check_ns_task import _normalize_ns


def test_normalize_ns_deduplicates_and_strips() -> None:
    values = ["NS1.EXAMPLE.COM.", "ns1.example.com", " ns2.example.com. "]
    assert _normalize_ns(values) == ["ns1.example.com", "ns2.example.com"]


def test_bulk_full_setup_task_module_imports() -> None:
    # Smoke import test for the task module to ensure task registration paths are valid.
    with patch("app.tasks.bulk_full_setup_task._set_ns"):
        from app.tasks import bulk_full_setup_task  # noqa: F401
