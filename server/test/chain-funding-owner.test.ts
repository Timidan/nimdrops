import type { PlainTransactionDetails } from '@nimiq/core'
import { describe, expect, it } from 'vitest'
import { NimiqChain } from '../src/chain/nimiq'

const CUSTODY = 'NQ90 6GXB LPNX K34M M8Q3 7XTT BQQ3 A1C4 1HMY'
const HTLC = 'NQ34 D851 V616 U24N 8PXJ RM8V 29MB 595S H0QD'
const CREATOR = 'NQ50 HBEF Y3GE YF5N X43L APT0 GM64 TX6L JR8A'
const RECIPIENT = 'NQ14 LU5R UH54 92SH GEN4 U63C SV4V 7N49 YYU4'

function earlyResolveFunding(): PlainTransactionDetails {
  return {
    transactionHash: 'b'.repeat(64),
    format: 'extended',
    sender: HTLC,
    senderType: 'htlc',
    recipient: CUSTODY,
    recipientType: 'basic',
    value: 5_000_000,
    fee: 0,
    feePerByte: 0,
    validityStartHeight: 57_475_974,
    network: 'main',
    flags: 0,
    senderData: { type: 'raw', raw: '' },
    data: { type: 'raw', raw: Buffer.from('ND1:test-drop').toString('hex') },
    proof: {
      type: 'early-resolve',
      raw: '01',
      signer: RECIPIENT,
      signature: '',
      publicKey: '',
      pathLength: 0,
      creator: CREATOR,
      creatorSignature: '',
      creatorPublicKey: '',
      creatorPathLength: 0,
    },
    size: 292,
    valid: true,
    state: 'confirmed',
    executionResult: true,
    blockHeight: 57_475_976,
    confirmations: 1,
    timestamp: 1_785_342_865_575,
  }
}

describe('funding owner extraction', () => {
  it('attributes an early-resolved HTLC payment to its creator instead of its contract', () => {
    const chain = new NimiqChain({ network: 'MainAlbatross', custodyAddress: CUSTODY })

    expect(chain.toChainTx(earlyResolveFunding())).toMatchObject({
      sender: HTLC,
      fundingOwner: CREATOR,
    })
  })
})
