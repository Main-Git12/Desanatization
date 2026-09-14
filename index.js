import express from 'express';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { registerExactEvmScheme } from '@x402/evm/exact/server';

const app = express();
app.use(express.json());

// 1. Connect to the live public facilitator
const facilitatorUrl = process.env.FACILITATOR_URL || 'https://x402.org/facilitator';
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

// 2. Initialize the core x402 resource server
const server = new x402ResourceServer(facilitatorClient);

// 3. Register the EVM exact payment scheme for Base network (eip155:8453)
registerExactEvmScheme(server, {
  networks: ['eip155:8453'],
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'x402 micro-settlement server is active and scheme registered' 
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
