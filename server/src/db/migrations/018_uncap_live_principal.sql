-- Remove the two ceilings on a drop's size: the headcount, and the aggregate
-- principal cap.
--
-- WHY. One signature funding many payouts is the product. A sponsor who wants
-- to hand 2 NIM each to 100 people should sign once and send 200 NIM, and the
-- old schema forbade both halves of that sentence: `claim_count BETWEEN 2 AND
-- 20`, and a 2 NIM ceiling on everything live at once. How much a drop holds
-- and how many people it is split across are the sponsor's decisions.
--
-- 1. HEADCOUNT. `drops_claim_count_range` becomes a floor with no ceiling. Two
--    is kept: a one-person drop is a Cashlink, and Nimiq already has those.
--    The only remaining upper bounds are the widths of the columns themselves
--    (`claim_count` is INT, `expected_funding_luna` is BIGINT), which
--    `assertDropShape` refuses ahead of the INSERT so that an absurd request is
--    a 400 rather than a 500.
--
-- 2. PRINCIPAL. `max_live_principal_luna` becomes
-- nullable and the singleton row is set to NULL, which means "no ceiling". The
-- mainnet deployment currently sits at 200000 luna (2 NIM) from the pilot
-- defaults; after this migration it will accept a drop of any size the ledger
-- can actually cover. That is a deliberate product decision, not a cleanup:
-- the whole point of NimDrops is that one signature funds many payouts, and a
-- 2 NIM ceiling made a 100-person packet impossible to express.
--
-- NO COLUMN IS DROPPED. The cap is retained as an operator kill switch, for
-- one reason: `paused` is the only other lever and it is all-or-nothing. An
-- operator watching an incident wants to stop NEW liabilities from being
-- created while the payouts already owed keep settling, and a ceiling set just
-- above current outstanding principal does exactly that. Pausing does not — it
-- stops the payouts too. Setting the cap needs no redeploy and no code change:
--
--   UPDATE custody_controls SET max_live_principal_luna = <luna> WHERE singleton;
--   UPDATE custody_controls SET max_live_principal_luna = NULL  WHERE singleton;
--
-- WHAT THIS DOES NOT CHANGE, and must not be read as changing:
--
--  * The SOLVENCY invariant. `ledger balance >= outstanding principal + added +
--    fee reserve` is arithmetic truth about money this system can actually pay,
--    not a policy ceiling, and it is untouched. A drop bigger than the custody
--    ledger can cover is still refused at activation, exactly as before, and
--    that refusal is now the only thing standing between a sponsor and a
--    liability nobody can settle. Read `assertSolvent`.
--  * `max_live_drops` (migration 014). Still a separate, still-optional ceiling
--    on the NUMBER of simultaneously live drops. The mainnet pilot sets it to
--    1, and with the principal cap off it is now the ONLY ceiling that deployment
--    has. An operator who wants concurrent drops sets it to NULL.
--  * The funding capacity RESERVATION (014). While the principal cap is NULL it
--    reserves no principal — there is nothing to run out of — but it still
--    holds a drop slot against `max_live_drops`, and it becomes load-bearing
--    again the moment the kill switch above is set. It is deliberately kept.

ALTER TABLE drops
  DROP CONSTRAINT drops_claim_count_range;

ALTER TABLE drops
  ADD CONSTRAINT drops_claim_count_range
    CHECK (claim_count >= 2);

COMMENT ON CONSTRAINT drops_claim_count_range ON drops IS
  'a drop needs at least two people; a one-person drop is a Cashlink. There is deliberately no '
  'upper bound — how many people a sponsor splits their drop across is their decision';

ALTER TABLE custody_controls
  ALTER COLUMN max_live_principal_luna DROP NOT NULL;

-- The 001 constraint covered both caps in one CHECK and read
-- `max_live_principal_luna >= 0 AND configured_fee_reserve_luna >= 0`, which is
-- NULL — and therefore not false, and therefore satisfied — for a null cap. It
-- is replaced by two separate constraints so the fee reserve keeps a real NOT
-- NULL floor of its own rather than inheriting the cap's nullability.
ALTER TABLE custody_controls
  DROP CONSTRAINT custody_controls_caps_non_negative;

ALTER TABLE custody_controls
  ADD CONSTRAINT custody_controls_max_live_principal_non_negative
    CHECK (max_live_principal_luna IS NULL OR max_live_principal_luna >= 0);

ALTER TABLE custody_controls
  ADD CONSTRAINT custody_controls_fee_reserve_non_negative
    CHECK (configured_fee_reserve_luna >= 0);

UPDATE custody_controls SET max_live_principal_luna = NULL WHERE singleton;

COMMENT ON COLUMN custody_controls.max_live_principal_luna IS
  'optional operator kill switch: the most principal all live drops may owe at once. '
  'NULL means no ceiling, which is the default — the solvency invariant, not this number, '
  'is what stops a drop the ledger cannot cover';
