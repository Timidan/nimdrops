import type { NetworkName } from '../config'
import { MAX_TOTAL_LUNA, formatNim } from '../money'
import { EXPIRY_HOURS, FUNDING_RESERVATION_MINUTES } from '../services/drops'
import type { CapacitySnapshot } from '../services/solvency'

/**
 * What a sponsor is told BEFORE their wallet asks them to approve anything.
 *
 * NimDrops is a custodial hot wallet with a disclosed cap. That sentence is the
 * whole product risk, and a sponsor who only finds it out afterwards has been
 * misled by omission — so the server owns the words rather than leaving them to
 * whatever the client happens to render. Every string below is built here, from
 * live numbers, and the web layer's only job is to show all of them above the
 * fund button.
 *
 * Rules the copy follows (repo `better-writing`): plain words, sentence case,
 * no exclamation marks, no blame, verbs a thumb can act on. Nothing here
 * softens what is being disclosed — "the operator can move everything in it" is
 * the true sentence, and a gentler one would be a worse one.
 *
 * The points are returned as an ORDERED list with stable ids. The order is the
 * reading order: what this is, who can take it, how much, where it goes, what
 * run this is, when the clock starts, how money comes back.
 */

export interface DisclosurePoint {
  /** Stable key, so the client can style or test one point without matching prose. */
  id: string
  text: string
}

export interface PilotLimits {
  /** Largest total one drop may hold, in NIM and in luna. */
  perDropMax: string
  perDropMaxLuna: string
  /** Largest total every live drop may hold together. */
  aggregateMax: string
  aggregateMaxLuna: string
  /** How much of the aggregate cap is free at this moment. */
  remaining: string
  remainingLuna: string
  /** `null` when only the principal cap applies. */
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
  /** Hours a drop stays claimable, counted from finalized activation. */
  expiryHours: number
  /** Minutes a funding request holds its room in the cap. */
  fundingWindowMinutes: number
  limits: PilotLimits
  /** One line for the space next to the fund button. */
  summary: string
  points: DisclosurePoint[]
}

function chainLabelFor(network: NetworkName): string {
  return network === 'MainAlbatross' ? 'the Nimiq main network' : 'the Nimiq test network'
}

/**
 * The largest single drop this deployment can accept: the launch cap from
 * `money.ts` or the aggregate cap, whichever bites first. On the mainnet pilot
 * the aggregate cap is the smaller of the two by two orders of magnitude, and
 * showing the 100 NIM launch cap there would be a number no sponsor could use.
 */
function perDropMaxLuna(capacity: CapacitySnapshot): bigint {
  return capacity.maxLivePrincipalLuna < MAX_TOTAL_LUNA
    ? capacity.maxLivePrincipalLuna
    : MAX_TOTAL_LUNA
}

function dropSlotSentence(capacity: CapacitySnapshot): string {
  if (capacity.maxLiveDrops === null) return ''
  if (capacity.maxLiveDrops === 1) return ' Only one drop can run at a time.'
  return ` Only ${capacity.maxLiveDrops} drops can run at a time.`
}

export function buildDisclosure(o: {
  network: NetworkName
  custodyAddress: string
  paused: boolean
  capacity: CapacitySnapshot
}): CustodyDisclosure {
  const { network, custodyAddress, paused, capacity } = o
  const mainnetPilot = network === 'MainAlbatross'
  const perDrop = formatNim(perDropMaxLuna(capacity))
  const aggregate = formatNim(capacity.maxLivePrincipalLuna)
  const remaining = formatNim(capacity.remainingLuna)

  const points: DisclosurePoint[] = [
    {
      id: 'not_escrow',
      text: 'This is not an escrow contract. Your NIM goes to one wallet the operator runs, and no code on chain holds it for you.',
    },
    {
      id: 'operator_key',
      text: 'The operator holds the only key to that wallet and can move everything in it, including your funding.',
    },
    {
      id: 'limits',
      text:
        `One drop can hold up to ${perDrop} NIM. All live drops together can hold ${aggregate} NIM, ` +
        `and ${remaining} NIM of that is free right now.${dropSlotSentence(capacity)}`,
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
      text: `The ${EXPIRY_HOURS} hour claim window starts when the network confirms your funding, not when you tap send.`,
    },
    {
      id: 'refunds',
      text: 'Whatever nobody claims goes back to the wallet you fund from. The operator signs that transfer, so a pause or a manual check can hold it up.',
    },
    {
      id: 'funding_window',
      text: `This drop holds its room in the cap for ${FUNDING_RESERVATION_MINUTES} minutes. Fund it in this session, or check the limits again before you send.`,
    },
  ]

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
    expiryHours: EXPIRY_HOURS,
    fundingWindowMinutes: FUNDING_RESERVATION_MINUTES,
    limits: {
      perDropMax: perDrop,
      perDropMaxLuna: perDropMaxLuna(capacity).toString(),
      aggregateMax: aggregate,
      aggregateMaxLuna: capacity.maxLivePrincipalLuna.toString(),
      remaining,
      remainingLuna: capacity.remainingLuna.toString(),
      maxLiveDrops: capacity.maxLiveDrops,
      liveDrops: capacity.liveDrops,
      reservedDrafts: capacity.reservedDrafts,
      remainingDrops: capacity.remainingDrops,
    },
    summary:
      `Your NIM goes to a wallet the operator controls, not to an escrow contract. ` +
      `Up to ${aggregate} NIM can be live at once.`,
    points,
  }
}
