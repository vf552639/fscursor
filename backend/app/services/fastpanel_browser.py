from dataclasses import dataclass


@dataclass
class BrowserActivationResult:
    success: bool
    message: str


async def activate_fastpanel_license_via_browser(
    *,
    panel_url: str,
    login: str,
    password: str,
) -> BrowserActivationResult:
    # Placeholder fallback for future Playwright/Selenium integration.
    # Keeps the integration point stable for task orchestration.
    if not panel_url or not login or not password:
        return BrowserActivationResult(False, "Missing panel credentials")
    return BrowserActivationResult(False, "Browser activation fallback is not configured yet")
