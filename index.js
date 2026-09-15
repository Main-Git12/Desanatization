import express from 'express';
import { x402ResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const app = express();
app.use(express.json());

const server = new x402ResourceServer();
server.register('eip155:8453', new ExactEvmScheme());

const routes = {
  'GET /api/resource': {
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        price: '1000000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x0da67e4e8d7e631f1acc39d1e92da67a9e6226c3',
      },
    ],
    description: 'Protected paid endpoint',
  },
};

app.get('/api/resource', server.middleware(routes), (req, res) => {
  res.json({ success: true, message: 'Welcome to the live mainnet resource!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
