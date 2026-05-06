def pytest_configure(config) -> None:
    import os

    os.environ.setdefault("USE_MEMORY_RATE_LIMIT", "1")


import pytest


@pytest.fixture(autouse=True)
def _disable_rate_limit_except_rate_tests(request: pytest.FixtureRequest) -> None:
    from app.main import app

    lim = app.state.limiter
    if "test_rate_limit" in request.node.nodeid:
        lim.enabled = True
        yield
        return
    lim.enabled = False
    yield
    lim.enabled = True
