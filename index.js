import express from 'express';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { registerExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware } from '@x402/express';

const app = express();
app.use(express.json());

const facilitatorUrl = process.env.FACILITATOR_URL || 'https://x402.org/facilitator';
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const server = new x402ResourceServer(facilitatorClient);

// Register for Base Sepolia Testnet
registerExactEvmScheme(server, {
  networks: ['eip155:84532'],
});

app.get('/api/premium-data', 
  paymentMiddleware({
    accepts: {
      scheme: 'exact',
      price: '$0.01',
      network: 'eip155:8453', // Base Sepolia Testnet
      payTo: process.env.PAY_TO || '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    },
    description: 'Access to premium data',
  }, server),
  (req, res) => {
    res.json({ success: true, message: 'Paid content unlocked!' });
  }
);

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'x402 testnet server is live!' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
