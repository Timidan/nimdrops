import type { NetworkName } from '../config'
import { finalityDepthBlocks } from '../config'
import { formatNim } from '../money'
import {
  DEFAULT_EXPIRY_HOURS,
  FUNDING_RESERVATION_MINUTES,
  formatExpiryWindow,
} from '../services/drops'
import type { CapacitySnapshot } from '../services/solvency'

/**
 * What a sponsor is told BEFORE their wallet asks them to approve anything.
 *
 * NimDrops is a custodial hot wallet. That sentence is the whole product risk,
 * and a sponsor who only finds it out afterwards has been misled by omission —
 * so the server owns the words rather than leaving them to whatever the client
 * happens to render. Every string below is built here, from live numbers, and
 * the web layer's only job is to show all of them above the fund button.
 *
 * **This copy was rewritten when the drop size cap was removed.** It used to
 * say a drop could hold at most N NIM, and to lean on that number as the
 * mitigation. There is no such number any more: how much a drop holds is the
 * sponsor's decision, so the honest disclosure names the exposure instead of a
 * ceiling — how much sponsors have funded and not yet had claimed — and names
 * the four mitigations that actually exist. A stale limit here would be a lie
 * shown to the one person being asked to trust it.
 *
 * Rules the copy follows (repo `better-writing`): plain words, sentence case,
 * no exclamation marks, no blame, verbs a thumb can act on. Nothing here
 * softens what is being disclosed — "the operator can move everything in it" is
 * the true sentence, and a gentler one would be a worse one.
 *
 * The points are returned as an ORDERED list with stable ids. The order is the
 * reading order: what this is, why no contract holds it, who can take it, how
 * much is exposed, what stands in the way, where it goes, what run this is,
 * when the clock starts, how money comes back.
 */

export interface DisclosurePoint {
  /** Stable key, so the client can style or test one point without matching prose. */
  id: string
  text: string
}

export interface PilotLimits {
  /**
   * Largest total every live drop may hold together, or `null` when the
   * operator has set no ceiling — which is the default. `null` is not "zero"
   * and not "unknown": it means no policy number limits a drop, and the
   * solvency invariant decides what the deployment can actually pay.
   */
  aggregateMax: string | null
  aggregateMaxLuna: string | null
  /** How much of the aggregate cap is free at this moment; `null` when uncapped. */
  remaining: string | null
  remainingLuna: string | null
  /** Funded principal that has not been paid out yet: the money at risk today. */
  atRisk: string
  atRiskLuna: string
  /** `null` when there is no limit on how many drops may run at once. */
  maxLiveDrops: number | null
  liveDrops: number
  reservedDrafts: number
  remainingDrops: number | null
}

export interface CustodyDisclosure {
  network: NetworkName
  /** How the chain is named in prose, e.g. "the Nimiq main network". */
  chainLabel: string
  custodyAddress: string
  /** True on MainAlbatross: this deployment is the first run with real NIM. */
  mainnetPilot: boolean
  /** Funding is closed while this is true. */
  paused: boolean
  /**
   * Hours a drop stays claimable, counted from finalized activation.
   *
   * This is the window the points below DESCRIBE, which since the window became
   * the sponsor's choice is not a constant. On `GET /api/custody` it is the
   * window that was asked about (the default when none was), and on the
   * `POST /api/drops` 201 it is the window that drop was created with. A client
   * that shows these sentences against a different number is showing a lie, so
   * the number travels with them.
   */
  expiryHours: number
  /** Minutes a funding request holds its room. */
  fundingWindowMinutes: number
  limits: PilotLimits
  /** One line for the space next to the fund button. */
  summary: string
  points: DisclosurePoint[]
}

function chainLabelFor(network: NetworkName): string {
  return network === 'MainAlbatross' ? 'the Nimiq main network' : 'the Nimiq test network'
}

function dropSlotSentence(capacity: CapacitySnapshot): string {
  if (capacity.maxLiveDrops === null) return ''
  if (capacity.maxLiveDrops === 1) return ' Only one drop can run at a time.'
  return ` Only ${capacity.maxLiveDrops} drops can run at a time.`
}

/**
 * The ceiling point, and only when there is a ceiling.
 *
 * The operator can still set `max_live_principal_luna` as a kill switch, and a
 * sponsor who is about to be refused by it deserves the number first. With no
 * cap and no drop limit this returns `null` and the point is simply absent —
 * printing "no limit" would read as a boast, and the exposure point below is
 * the sentence that carries the weight.
 */
function limitsPoint(capacity: CapacitySnapshot): DisclosurePoint | null {
  const slots = dropSlotSentence(capacity)
  if (capacity.maxLivePrincipalLuna === null) {
    return slots === '' ? null : { id: 'limits', text: slots.trim() }
  }
  const aggregate = formatNim(capacity.maxLivePrincipalLuna)
  const remaining = formatNim(capacity.remainingLuna ?? 0n)
  return {
    id: 'limits',
    text:
      `The operator has capped all live drops together at ${aggregate} NIM, and ${remaining} NIM ` +
      `of that is free right now.${slots}`,
  }
}

export function buildDisclosure(o: {
  network: NetworkName
  custodyAddress: string
  paused: boolean
  capacity: CapacitySnapshot
  /**
   * The claim window these sentences must describe. Omitted means the default,
   * which is what a sponsor who has not chosen yet is looking at.
   */
  expiryHours?: number
}): CustodyDisclosure {
  const { network, custodyAddress, paused, capacity } = o
  const expiryHours = o.expiryHours ?? DEFAULT_EXPIRY_HOURS
  const mainnetPilot = network === 'MainAlbatross'
  const aggregate =
    capacity.maxLivePrincipalLuna === null ? null : formatNim(capacity.maxLivePrincipalLuna)
  const remaining = capacity.remainingLuna === null ? null : formatNim(capacity.remainingLuna)
  const atRisk = formatNim(capacity.outstandingLuna)

  const points: DisclosurePoint[] = [
    {
      id: 'not_escrow',
      text: 'This is not an escrow contract. Your NIM goes to one wallet the operator runs, and no code on chain holds it for you.',
    },
    {
      id: 'why_no_contract',
      text: 'A Nimiq HTLC pays one named recipient. A drop pays a list of people nobody knows yet, so no contract on this chain can hold the money. A person holds it instead.',
    },
    {
      id: 'operator_key',
      text: 'The operator holds the only key to that wallet and can move everything in it, including your funding.',
    },
    {
      id: 'exposure',
      text:
        'Nothing limits the size of a drop, so the amount at risk is whatever sponsors have ' +
        `funded and nobody has claimed yet. That is ${atRisk} NIM right now, and your drop adds to it.`,
    },
    {
      id: 'mitigations',
      text:
        'What stands in the way is not cryptography. The books are checked against the chain ' +
        'before anything is signed, only one process is ever allowed to sign, the operator can ' +
        'stop every payment at once, and funding does not count until the network has buried it ' +
        `${finalityDepthBlocks()} blocks deep.`,
    },
    {
      id: 'destination',
      text: `You are sending to ${custodyAddress} on ${chainLabelFor(network)}. Check that address in your wallet before you approve.`,
    },
    mainnetPilot
      ? {
          id: 'first_mainnet_run',
          text: 'This is the first run with real NIM. Send a small amount and expect to watch it.',
        }
      : {
          id: 'test_network',
          text: 'This runs on the Nimiq test network. The NIM here is not real money.',
        },
    {
      id: 'expiry_clock',
      // Two sentences, because the window is now a decision and a decision
      // needs its consequence next to it. The first says when the clock starts,
      // which is the thing sponsors got wrong before this control existed. The
      // second says what choosing a long one costs: the operator holds the NIM
      // for all of it, and neither side can cut it short — there is no sponsor
      // cancel and no operator close, only the sweep at `expires_at`.
      text:
        `The ${formatExpiryWindow(expiryHours)} claim window starts when the network confirms your ` +
        `funding, not when you tap send. The operator holds your NIM for the whole window, and no ` +
        `one can end a drop early.`,
    },
    {
      id: 'refunds',
      text: 'Whatever nobody claims goes back to the wallet you fund from. The operator signs that transfer, so a pause or a manual check can hold it up.',
    },
  ]

  const limits = limitsPoint(capacity)
  if (limits) {
    // Between the exposure and the destination: a sponsor reads how much is at
    // stake, then what the operator has done to bound it, then where to send.
    points.splice(points.findIndex((p) => p.id === 'mitigations') + 1, 0, limits)
    points.push({
      id: 'funding_window',
      text: `This drop holds its room for ${FUNDING_RESERVATION_MINUTES} minutes. Fund it in this session, or check the limits again before you send.`,
    })
  }

  if (paused) {
    points.unshift({
      id: 'paused',
      text: 'Funding is closed right now. The operator has to open it before a new drop can start.',
    })
  }

  return {
    network,
    chainLabel: chainLabelFor(network),
    custodyAddress,
    mainnetPilot,
    paused,
    expiryHours,
    fundingWindowMinutes: FUNDING_RESERVATION_MINUTES,
    limits: {
      aggregateMax: aggregate,
      aggregateMaxLuna: capacity.maxLivePrincipalLuna?.toString() ?? null,
      remaining,
      remainingLuna: capacity.remainingLuna?.toString() ?? null,
      atRisk,
      atRiskLuna: capacity.outstandingLuna.toString(),
      maxLiveDrops: capacity.maxLiveDrops,
      liveDrops: capacity.liveDrops,
      reservedDrafts: capacity.reservedDrafts,
      remainingDrops: capacity.remainingDrops,
    },
    summary:
      `Your NIM goes to a wallet the operator controls, not to an escrow contract. ` +
      `${atRisk} NIM is sitting there unclaimed right now.`,
    points,
  }
}
