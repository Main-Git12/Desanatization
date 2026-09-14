import express from 'express';
import { x402 } from '@x402/core';

const app = express();

// Middleware
app.use(express.json());

// Initialize x402 middleware or routes here according to your setup
// Example route protected or handled by x402:
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'x402 micro-settlement server is active' });
});

// Use Railway's dynamic port or default to 3000 locally
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
