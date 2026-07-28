-- One wallet, one spelling, in every address-keyed gate table.
--
-- `NQ07 ABCD…`, `nq07abcd…` and `NQ07ABCD…` are one wallet and three strings.
-- Every rule these tables carry is enforced with `WHERE wallet_address = $1` or
-- a UNIQUE constraint over that text column, so each of them is a rule about a
-- WALLET only for as long as one wallet is one string:
--
--   * gate_grants        UNIQUE (drop_id, wallet_address) — one grant per wallet
--   * passphrase_attempts  five wrong guesses per wallet per hour
--   * trivia_seen        PRIMARY KEY (wallet_address, question_id) — never twice
--   * trivia_sessions    the cooldown and the resume lookup
--
-- The application began canonicalising on the way in (`requireGateWallet`), and
-- that half alone is worse than either half on its own: a row written in the old
-- spelling becomes INVISIBLE to the new lookups. An eligible claimant is refused
-- `gate_required` because `reserveClaim` cannot see their grant; a wallet that
-- has spent all five passphrase guesses is handed five more; a question a wallet
-- has already answered can be dealt to it again. This migration is the other
-- half, and without it the fix is a regression.
--
-- Scope note, recorded rather than assumed: no deployed database is known to
-- hold such a row. The mainnet deployment has never run migration 019, so it has
-- no gates tables at all. This runs anyway, because "we think there is no such
-- data" is not something a schema should rely on, and because a developer
-- database that predates the change is exactly where this would otherwise bite
-- silently.

-- ---------------------------------------------------------------------------
-- The canonical spelling: no whitespace, uppercase.
-- ---------------------------------------------------------------------------
--
-- Deliberately NOT a checksum validator. This is a spelling change, and a row
-- whose address never had a valid checksum was unclaimable before this migration
-- and stays unclaimable after it. Deleting such rows would be a data-loss
-- decision taken inside a rename, so they are left exactly as they are, merely
-- compacted.
CREATE OR REPLACE FUNCTION nimdrops_canonical_address(addr text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT upper(regexp_replace(addr, '\s', '', 'g'))
$$;

-- ---------------------------------------------------------------------------
-- gate_grants — merge, do not just rewrite.
-- ---------------------------------------------------------------------------
--
-- Two spellings of one wallet may BOTH hold a grant on one drop; rewriting both
-- would violate `UNIQUE (drop_id, wallet_address)` and abort the migration. So
-- the survivor is chosen first, and it is chosen by consumption rather than by
-- age: a consumed grant is the one that already paid a claim, and losing the
-- link between that claim and its grant would misreport the drop's history.
-- Among unconsumed duplicates the oldest wins, arbitrarily but stably.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY drop_id, nimdrops_canonical_address(wallet_address)
           ORDER BY (consumed_claim_id IS NOT NULL) DESC, granted_at, id
         ) AS rank
  FROM gate_grants
)
DELETE FROM gate_grants g USING ranked r
WHERE g.id = r.id AND r.rank > 1;

UPDATE gate_grants
SET wallet_address = nimdrops_canonical_address(wallet_address)
WHERE wallet_address <> nimdrops_canonical_address(wallet_address);

-- ---------------------------------------------------------------------------
-- trivia_seen — merge on the primary key, keeping the EARLIEST sighting.
-- ---------------------------------------------------------------------------
--
-- Same collision shape, opposite tie-break. This table's only job is to answer
-- "has this wallet been shown this question", and the answer is yes from the
-- first sighting onwards, so the earliest row is the truthful one to keep.
WITH ranked AS (
  SELECT ctid,
         row_number() OVER (
           PARTITION BY nimdrops_canonical_address(wallet_address), question_id
           ORDER BY seen_at, ctid
         ) AS rank
  FROM trivia_seen
)
DELETE FROM trivia_seen t USING ranked r
WHERE t.ctid = r.ctid AND r.rank > 1;

UPDATE trivia_seen
SET wallet_address = nimdrops_canonical_address(wallet_address)
WHERE wallet_address <> nimdrops_canonical_address(wallet_address);

-- ---------------------------------------------------------------------------
-- trivia_sessions and passphrase_attempts — no unique constraint to collide on.
-- ---------------------------------------------------------------------------
--
-- Both are append-only histories, so two spellings simply become two rows under
-- one wallet, which is what they should always have been. Merging them is the
-- point: the cooldown reads the most recent session for a wallet, and the cap
-- counts the last hour's attempts for a wallet, and both were previously reading
-- one spelling's slice of that history.
UPDATE trivia_sessions
SET wallet_address = nimdrops_canonical_address(wallet_address)
WHERE wallet_address <> nimdrops_canonical_address(wallet_address);

UPDATE passphrase_attempts
SET wallet_address = nimdrops_canonical_address(wallet_address)
WHERE wallet_address <> nimdrops_canonical_address(wallet_address);

-- ---------------------------------------------------------------------------
-- Keep it true, rather than trusting every future writer to remember.
-- ---------------------------------------------------------------------------
--
-- `issueGrant` canonicalises, and it is the only production writer of
-- gate_grants — but "the only writer" is a property of today's code, not of the
-- schema. A spike script, an operator's psql session or a kind added later can
-- all insert directly. The constraint is what makes the invariant survive them.
--
-- Only on gate_grants, deliberately. It is the row the money path matches
-- against, so a wrong spelling there costs somebody their claim; the other three
-- tables cost a repeated question or a reset guess budget, and are not worth
-- turning an operator's manual INSERT into a hard error.
ALTER TABLE gate_grants
  ADD CONSTRAINT gate_grants_wallet_address_canonical
  CHECK (wallet_address = upper(regexp_replace(wallet_address, '\s', '', 'g')));
