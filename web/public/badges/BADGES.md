# App store badge manifest

Retrieved and rule-checked on **2026-07-27**. Both files are the trademark
holder's own artwork, byte for byte, self-hosted because the app's CSP allows
no external origin. Neither has been redrawn, recoloured, cropped, restretched
or re-encoded.

## Apple — "Download on the App Store"

- **File:** `download-on-the-app-store.svg` (119.664 x 40, black badge)
- **Source URL:** https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg
- **Guidelines:** https://developer.apple.com/app-store/marketing/guidelines/
- **SHA-256:** `a26fc5b38380272c92e9019a2eb8b45542a66814b3e2b203772db8904b9fb99f`
- **Rules honoured**
  - Minimum onscreen height 40px. Rendered at 40px.
  - Clear space of at least one quarter of the badge height. The link pads the
    badge by `40 / 4 = 10px` on all sides (`.nd-store[data-store='ios']`).
  - Not modified, angled or animated. No hover fill, no border, no radius and
    no filter is applied to the artwork; the focus ring is drawn outside it.
  - The grey border is part of the artwork and is left alone.
  - "App Store" is never translated. The US/UK English badge is used as
    published.
- **Deviation, stated rather than hidden:** Apple asks for its badge to be
  placed first in a lineup. NimDrops orders the pair by the visitor's own
  platform, so an Android reader sees Google Play first. The ordering exists so
  the reader's own store is the first thing under their thumb; both badges are
  always present, at the same size, and neither is marked.

## Google — "Get it on Google Play"

- **File:** `get-it-on-google-play.png` (646 x 250 canvas; 564 x 168 badge)
- **Source URL:** https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png
- **Guidelines:** https://partnermarketinghub.withgoogle.com/brands/google-play/visual-identity/badge-guidelines/
- **SHA-256:** `f72611e2df8e88204009fd896d05d5e8e83c77009c63943bbffa169559934849`
- **Rules honoured**
  - Clear space of one quarter of the badge height. Google ships it inside the
    file — the 41px transparent margin around the 168px badge — so the artwork
    is scaled by its canvas and padded by nothing.
  - Never smaller than a neighbouring store badge. Both badges render at a
    40px badge height, and Google's is the wider of the two.
  - Colour unchanged, elements neither removed nor rearranged, wordmark and
    icon not rescaled relative to each other.
- **Format note:** Google publishes the web badge as PNG. The SVG copies in
  circulation are community redraws, so the PNG is what ships here.

## Both

- The badges link to **Nimiq Pay**, which is Nimiq's app and not ours. The
  badges exist to drive installs from the stores, which is exactly what these
  links do, and no claim of authorship is made anywhere near them. If the
  owner would rather not use another publisher's store badges for their app,
  the fallback is plain text links.
- Neither URL carries a campaign, referrer or attribution parameter.
  `ui/OpenInApp.test.tsx` fails if one ever grows one.
