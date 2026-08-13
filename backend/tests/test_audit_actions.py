from app.audit.service import SAFE_ACTIONS

EXECUTIVE_ACTIONS = [
    "cf.zone.create",
    "cf.dns.create",
    "cf.dns.update",
    "cf.dns.delete",
    "cf.cache_purge",
    "registrar.ns_set",
    "server.fastpanel_install",
]


def test_executive_actions_are_in_safe_actions():
    for action in EXECUTIVE_ACTIONS:
        assert action in SAFE_ACTIONS, f"{action} must be allow-listed"


def test_device_action_complete_still_present():
    # provision продолжает логироваться под этим действием
    assert "device.action.complete" in SAFE_ACTIONS


MUTATION_AUDIT_ACTIONS = [
    "blob.upsert",
    "blob.delete",
    "settings.config_update",
    "settings.notification_test",
    "notification.mark_read",
    "notification.delete",
    "notification.check_renewals",
]


def test_mutation_actions_are_in_safe_actions():
    from app.audit.service import SAFE_ACTIONS

    for action in MUTATION_AUDIT_ACTIONS:
        assert action in SAFE_ACTIONS, f"{action} must be allow-listed"


# Массовые (bulk) маршруты: до этого спринта единичный CRUD писался в аудит,
# а его bulk-вариант — нет (перенос одного домена оставлял след, перенос 500 —
# нет). audit_service.log бросает ValueError на неизвестное действие, поэтому
# allow-list — обязательное условие, а не косметика.
BULK_AUDIT_ACTIONS = [
    "domain.bulk_create",
    "domain.bulk_import",
    "domain.bulk_assign_server",
    "domain.bulk_assign_cloudflare",
    "domain.full_setup",
    "server.bulk_import",
]


def test_bulk_actions_are_in_safe_actions():
    from app.audit.service import SAFE_ACTIONS

    for action in BULK_AUDIT_ACTIONS:
        assert action in SAFE_ACTIONS, f"{action} must be allow-listed"
