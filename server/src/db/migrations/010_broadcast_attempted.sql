-- Tell "signed, never broadcast" apart from "signed, broadcast outcome unknown"
-- (round-3 review R4, the residue of round-2 N1).
--
-- `broadcastStored` deliberately leaves an attempt in `signed` when the
-- broadcast call throws, because a throw is an UNKNOWN OUTCOME: the bytes may
-- be in a mempool already. The same state is produced by a process killed
-- between the network accepting the transaction and `markBroadcast` committing
-- — crash window (b), which the G1 harness reproduces on purpose.
--
-- N1's cross-check offset excludes every `signed` attempt on the argument that
-- "the bytes never left this process, so the chain cannot have debited them".
-- That argument is true for an attempt that was never handed to the network and
-- false for an ambiguous one. When it is false the chain HAS debited the money
-- and the offset does not explain it, so `reconcile()` reads an ordinary
-- in-flight payment as a shortfall and pauses custody — on restart, before the
-- attempt is even reconciled, and confirming the attempt afterwards does not
-- unpause anything.
--
-- This column records the distinction at the only moment it is knowable: just
-- before the broadcast call is made, committed before the bytes leave, so a
-- crash cannot lose it. `NULL` now means "never handed to the network" and is
-- provable rather than assumed.
ALTER TABLE transaction_attempts
  ADD COLUMN broadcast_attempted_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN transaction_attempts.broadcast_attempted_at IS
  'when broadcast was first ATTEMPTED (written before the call); NULL means the bytes never left this process';

-- Backfill only what is provable. An attempt that reached `broadcast` or
-- `confirmed` was acknowledged by the network, so a broadcast was certainly
-- attempted for it; `created_at` is the closest true-by-construction lower
-- bound we hold.
UPDATE transaction_attempts
SET broadcast_attempted_at = created_at
WHERE state IN ('broadcast', 'confirmed')
  AND broadcast_attempted_at IS NULL;

-- Pre-existing `signed` rows are deliberately left NULL. Whether their bytes
-- ever reached the network is not recorded anywhere, and guessing "yes" would
-- hand a stale attempt a permanent alibi in the cross-check — exactly the hole
-- N1 closed. Guessing "no" keeps the current (fail-closed for detection)
-- behaviour: such an attempt does not offset the cross-check, and
-- `staleInFlightOutgoing` reports it to an operator.
