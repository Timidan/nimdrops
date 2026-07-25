// Sanctioned crypto-primitive surface for auth/ — the only @nimiq/core import
// outside chain/nimiq.ts.
//
// The boundary rule is "only chain/ touches @nimiq/core", and `auth/verify.ts`
// legitimately needs two pure primitives (no client, no consensus, no keys).
// Routing them through this file keeps the rule mechanically checkable: a grep
// for `@nimiq/core` under src/ must return exactly `chain/nimiq.ts` and this
// module. Add nothing here that talks to a network or holds a secret.
export { PublicKey, Signature } from '@nimiq/core'
