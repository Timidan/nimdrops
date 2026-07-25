-- Documentation-only migration: no DDL, no data movement, no behaviour change.
--
-- Three block-hash columns and one raw-transaction column have carried unstated
-- intent since 001_core.sql. A reader of the schema alone cannot tell "reserved
-- for later" from "the writer is missing and that is a bug", and a column that
-- is always NULL for the wrong reason is how audit trails quietly rot. These
-- comments put the answer where the next person actually looks: \d+ on the
-- table. They are kept rather than dropped because the columns are genuinely
-- wanted — dropping them would cost a migration to add back, and a reorg
-- investigation needs exactly the block hash a transaction was seen in.

COMMENT ON COLUMN drops.funding_block_hash IS
  'reserved: no writer yet; populate when ChainTx carries block hashes';

COMMENT ON COLUMN transaction_attempts.observed_block_hash IS
  'reserved: no writer yet; populate when ChainTx carries block hashes';

COMMENT ON COLUMN transaction_attempts.confirmed_block_hash IS
  'reserved: no writer yet; populate when ChainTx carries block hashes';

-- The 001_core.sql inline comment reads "encrypted at rest if available", which
-- overstates what the code does: these are plaintext signed transaction bytes.
-- They cannot double-pay (rebroadcasting identical bytes is idempotent by hash)
-- but they do reveal every payout in full, so this is a real disclosure surface.
COMMENT ON COLUMN transaction_attempts.raw_signed_tx IS
  'encryption at rest not implemented; see Task 18';
