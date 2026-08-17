"""vault key: the password-wrapped key the blobs are actually encrypted with

Revision ID: 018_vault_key
Revises: 017_domain_fastpanel_facts
Create Date: 2026-08-17

Until now the key that encrypts the blobs WAS the key derived from the password
(``derive_master_key(password, salt)``). Recovery rotates both salt and password,
and nothing re-encrypts anything, so the key derived afterwards no longer equals
the one the ciphertexts were made with — every secret of the account gone, with
no way back. This column is the fix, borrowed from 1Password: a random vault key
(VK) encrypts the blobs, the password-derived key (KEK) only wraps it, and here
lies that wrapper — ``aead(VK, KEK)``, opaque to the server. Changing or
recovering the password rewrites these 72 bytes instead of touching a blob.

Nullable, and there is nothing to backfill: the server knows neither VK nor KEK.
NULL reads as "account from before the split", which means ``VK == KEK`` — and
that equality is why the transition costs nothing: such an account already has
its blobs encrypted with what is now its VK, and its recovery blob already wraps
that very key. The client fills the column in on its next sign-in (``POST
/auth/vault-key/init``), so the state is per-account and temporary, but has no
deadline: until then everything keeps working exactly as it did.
"""
from typing import Optional, Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "018_vault_key"
down_revision: Optional[str] = "017_domain_fastpanel_facts"
branch_labels: Optional[Union[str, Sequence[str]]] = None
depends_on: Optional[Union[str, Sequence[str]]] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("wrapped_vault_key", sa.LargeBinary(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "wrapped_vault_key")
