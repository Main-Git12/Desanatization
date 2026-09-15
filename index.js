import express from 'express';
import { createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const app = express();
app.use(express.json());

// Server wallet (must have ETH on Base Mainnet to pay gas)
// Ensure you set PRIVATE_KEY in your Railway environment variables!
const serverPrivateKey = process.env.PRIVATE_KEY;
if (!serverPrivateKey) {
  console.error("ERROR: PRIVATE_KEY environment variable is not set!");
  process.exit(1);
}

const account = privateKeyToAccount(serverPrivateKey);

const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http('https://mainnet.base.org'),
});

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_ABI = parseAbi([
  'function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external'
]);

console.log(`Server wallet address (Payee & Gas Payer): ${account.address}`);

app.get('/api/premium-data', async (req, res) => {
  const paymentSignatureHeader = req.headers['payment-signature'];

  // If no payment header is provided, issue 402 Payment Required
  if (!paymentSignatureHeader) {
    const paymentRequirement = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          asset: USDC_ADDRESS,
          amount: '10000', // 0.01 USDC (6 decimals)
          payTo: account.address, // Server wallet receives the funds
          chainId: 8453,
        }
      ]
    };
    const encoded = Buffer.from(JSON.stringify(paymentRequirement)).toString('base64');
    res.setHeader('payment-required', encoded);
    return res.status(402).json({ error: 'Payment required' });
  }

  try {
    // Decode the incoming authorization payload from the client
    const decodedPayload = JSON.parse(Buffer.from(paymentSignatureHeader, 'base64').toString('utf8'));
    const { authorization } = decodedPayload.payload;

    console.log(`Executing on-chain settlement for nonce ${authorization.nonce}...`);
    console.log(`From: ${authorization.from} | To: ${authorization.to} | Value: ${authorization.value}`);

    // Execute receiveWithAuthorization on Base Mainnet USDC contract
    const txHash = await walletClient.writeContract({
      address: USDC_ADDRESS,
      abi: USDC_ABI,
      functionName: 'receiveWithAuthorization',
      args: [
        authorization.from,
        authorization.to,
        BigInt(authorization.value),
        BigInt(authorization.validAfter),
        BigInt(authorization.validBefore),
        authorization.nonce,
        Number(authorization.v),
        authorization.r,
        authorization.s,
      ],
    });

    console.log(`Settlement successful! TxHash: ${txHash}`);

    // Return the protected premium data
    return res.json({
      success: true,
      message: 'Payment verified and settled on-chain!',
      data: {
        secretPayload: 'Here is your exclusive x402 data stream.',
        transactionHash: txHash
      }
    });

  } catch (error) {
    console.error('Payment processing error:', error);
    return res.status(500).json({ 
      error: 'Payment settlement failed', 
      details: error.shortMessage || error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
