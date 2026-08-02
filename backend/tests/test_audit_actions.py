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
