import pytest
from sqlalchemy import text

from app.core.database import engine
from app.main import EXPECTED_ALEMBIC_HEAD


@pytest.mark.asyncio
async def test_expected_alembic_head_matches_actual_db_head():
    """The constant must match the actual head Alembic upgrades to."""
    async with engine.connect() as conn:
        result = await conn.execute(text("SELECT version_num FROM alembic_version"))
        row = result.fetchone()
    assert row is not None, "alembic_version is empty - run alembic upgrade head"
    assert row[0] == EXPECTED_ALEMBIC_HEAD, (
        f"DB at {row[0]!r} but EXPECTED_ALEMBIC_HEAD={EXPECTED_ALEMBIC_HEAD!r}"
    )
