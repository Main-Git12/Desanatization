// ============================================================================
// Stub Facilitator Client (test support)
//
// Implements the FacilitatorClient contract in-process so the x402 middleware
// can be exercised end to end — 402 challenge generation, verification,
// settlement and the PAYMENT-RESPONSE header — without network access or
// spending real USDC.
// ============================================================================

/** Base Sepolia USDC, the default asset for eip155:84532. */
export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

/** Base mainnet USDC, the default asset for eip155:8453. */
export const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/**
 * Create a facilitator client that always verifies and settles successfully.
 *
 * @param {object} [options] - Stub behaviour
 * @param {string} [options.network='eip155:84532'] - Network to advertise
 * @param {string} [options.scheme='exact'] - Scheme to advertise
 * @param {boolean} [options.verifyOk=true] - Whether verify() reports valid
 * @param {boolean} [options.settleOk=true] - Whether settle() reports success
 * @returns {object} FacilitatorClient implementation + call log
 */
export function createStubFacilitator({
  network = 'eip155:84532',
  scheme = 'exact',
  verifyOk = true,
  settleOk = true,
} = {}) {
  const calls = { getSupported: 0, verify: 0, settle: 0 };

  return {
    calls,

    /** @returns {Promise<object>} Supported kinds as a real facilitator would report */
    async getSupported() {
      calls.getSupported++;
      return {
        kinds: [{ x402Version: 2, scheme, network }],
        extensions: [],
        signers: {},
      };
    },

    /** @returns {Promise<object>} Verification response */
    async verify(_paymentPayload, _requirements) {
      calls.verify++;
      return verifyOk
        ? { isValid: true, payer: '0x1111111111111111111111111111111111111111' }
        : { isValid: false, invalidReason: 'stub_rejected' };
    },

    /** @returns {Promise<object>} Settlement response */
    async settle(_paymentPayload, requirements) {
      calls.settle++;
      return {
        success: settleOk,
        transaction: `0x${'ab'.repeat(32)}`,
        network: requirements?.network ?? network,
        payer: '0x1111111111111111111111111111111111111111',
        amount: requirements?.amount ?? '1000',
        errorReason: settleOk ? undefined : 'stub_settle_failed',
      };
    },
  };
}

/**
 * Create a facilitator client that cannot be reached — used to assert the
 * not-ready path.
 *
 * @returns {object} FacilitatorClient whose getSupported() always rejects
 */
export function createOfflineFacilitator() {
  const failure = () => Promise.reject(new Error('stub facilitator unreachable'));
  return {
    // Each method must RETURN the rejection: the SDK reads the resolved value.
    getSupported: () => failure(),
    verify: () => failure(),
    settle: () => failure(),
  };
}