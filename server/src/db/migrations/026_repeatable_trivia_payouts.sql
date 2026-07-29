-- Every passed trivia session earns one independently consumable payout.
-- Other gates and ordinary drops retain their one-claim-per-wallet behavior.

ALTER TABLE gate_grants
  ADD COLUMN trivia_session_id UUID NULL REFERENCES trivia_sessions(id);

-- Attach the legacy per-wallet trivia grant to the first pass that created it.
UPDATE gate_grants g
SET trivia_session_id = (
  SELECT s.id
  FROM trivia_sessions s
  WHERE s.drop_id = g.drop_id
    AND s.wallet_address = g.wallet_address
    AND s.state = 'passed'
  ORDER BY s.completed_at NULLS LAST, s.started_at, s.id
  LIMIT 1
)
WHERE g.kind = 'trivia';

ALTER TABLE gate_grants
  DROP CONSTRAINT gate_grants_drop_id_wallet_address_key;

CREATE UNIQUE INDEX gate_grants_non_trivia_wallet_once
  ON gate_grants (drop_id, wallet_address)
  WHERE kind <> 'trivia';

CREATE UNIQUE INDEX gate_grants_trivia_session_once
  ON gate_grants (trivia_session_id)
  WHERE trivia_session_id IS NOT NULL;

ALTER TABLE gate_grants
  ADD CONSTRAINT gate_grants_trivia_session_shape
  CHECK ((kind = 'trivia') = (trivia_session_id IS NOT NULL));

-- Replays completed after trivia became replayable did not receive a second
-- grant under the old uniqueness rule. Materialise those earned payouts now.
INSERT INTO gate_grants (
  drop_id, wallet_address, kind, granted_at, payout_permille, trivia_session_id
)
SELECT s.drop_id,
       s.wallet_address,
       'trivia',
       COALESCE(s.completed_at, s.started_at),
       ((count(*) FILTER (WHERE a.is_correct = true) * 1000) / NULLIF(count(*), 0))::smallint,
       s.id
FROM trivia_sessions s
JOIN trivia_answers a ON a.session_id = s.id
WHERE s.state = 'passed'
  AND NOT EXISTS (
    SELECT 1 FROM gate_grants g WHERE g.trivia_session_id = s.id
  )
GROUP BY s.id;

ALTER TABLE claims
  ADD COLUMN gate_grant_id UUID NULL REFERENCES gate_grants(id);

UPDATE claims c
SET gate_grant_id = g.id
FROM gate_grants g
WHERE g.consumed_claim_id = c.id;

ALTER TABLE claims
  DROP CONSTRAINT claims_drop_id_recipient_address_key;

CREATE UNIQUE INDEX claims_without_grant_wallet_once
  ON claims (drop_id, recipient_address)
  WHERE gate_grant_id IS NULL;

CREATE UNIQUE INDEX claims_gate_grant_once
  ON claims (gate_grant_id)
  WHERE gate_grant_id IS NOT NULL;
