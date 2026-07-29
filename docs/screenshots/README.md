# Screenshots

Product screenshots for the project README and other documentation. These are
optimized, curated exports; the full design-process archive they came from is
kept outside this repository.

They are renders, so interface copy can lag the shipped strings: `claim.png`
shows the primary action as "Open 5 NIM", which the app now words as "Claim 5
NIM". Re-export from the running app when a screenshot's copy stops matching
what the code says.

- **`share-link.png`** — The link a sponsor shares, opened without a wallet: a
  sealed envelope, the "Open in Nimiq Pay" button, and a QR code to hand off
  to a phone that has the wallet installed.
- **`sealed-envelope.png`** — The claim screen before opening: a sealed red
  envelope with a "Hold to open" prompt. Nothing is signed yet.
- **`claim.png`** — After the hold gesture: the fixed share amount is
  revealed (same for every claimant), along with shares-remaining and
  time-to-close, and the one-signature "Open" action.
- **`claimed.png`** — After signing: the "Paid" confirmation with the
  on-chain transaction, a link to the Nimiq explorer, and the option to drop
  a share back in or share the app.
