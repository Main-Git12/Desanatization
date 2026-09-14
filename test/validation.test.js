// ============================================================================
// Request Validation Tests
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { validatePaymentHeaders, assignRequestId, validateContentType } from '../middleware/validation.js';

const createTestApp = () => {
  const app = express();
  app.use(express.json());
  app.use(assignRequestId);
  app.use(validateContentType);
  
  app.get('/protected', validatePaymentHeaders, (req, res) => {
    res.json({ success: true, token: req.paymentProof });
  });
  
  app.post('/data', (req, res) => {
    res.json({ received: req.body });
  });

  return app;
};

test('Validation - Missing authorization header returns 401', async () => {
  const app = createTestApp();
  
  await new Promise((resolve) => {
    const server = app.listen(3335, async () => {
      try {
        const response = await fetch('http://localhost:3335/protected');
        assert.strictEqual(response.status, 401);
        
        const data = await response.json();
        assert(data.error.includes('authorization header'));
        
        console.log('✓ Missing authorization header properly rejected');
      } finally {
        server.close(resolve);
      }
    });
  });
});

test('Validation - Valid authorization header accepted', async () => {
  const app = createTestApp();
  
  await new Promise((resolve) => {
    const server = app.listen(3336, async () => {
      try {
        const response = await fetch('http://localhost:3336/protected', {
          headers: {
            'Authorization': 'Bearer valid-payment-proof'
          }
        });
        
        assert.strictEqual(response.status, 200);
        const data = await response.json();
        assert.strictEqual(data.token, 'valid-payment-proof');
        
        console.log('✓ Valid authorization header accepted');
      } finally {
        server.close(resolve);
      }
    });
  });
});

test('Validation - Invalid authorization format returns 401', async () => {
  const app = createTestApp();
  
  await new Promise((resolve) => {
    const server = app.listen(3337, async () => {
      try {
        const response = await fetch('http://localhost:3337/protected', {
          headers: {
            'Authorization': 'InvalidFormat token'
          }
        });
        
        assert.strictEqual(response.status, 401);
        
        console.log('✓ Invalid authorization format properly rejected');
      } finally {
        server.close(resolve);
      }
    });
  });
});

test('Validation - Request ID is assigned', async () => {
  const app = createTestApp();
  
  await new Promise((resolve) => {
    const server = app.listen(3338, async () => {
      try {
        const response = await fetch('http://localhost:3338/protected');
        const data = await response.json();
        
        assert(data.requestId);
        assert(data.requestId.startsWith('req-'));
        
        console.log('✓ Request ID properly assigned');
      } finally {
        server.close(resolve);
      }
    });
  });
});

test('Validation - Content-Type validation for POST', async () => {
  const app = createTestApp();
  
  await new Promise((resolve) => {
    const server = app.listen(3339, async () => {
      try {
        // Test with invalid content type
        const response = await fetch('http://localhost:3339/data', {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain'
          },
          body: 'invalid'
        });
        
        assert.strictEqual(response.status, 400);
        const data = await response.json();
        assert(data.error.includes('application/json'));
        
        console.log('✓ Content-Type validation working');
      } finally {
        server.close(resolve);
      }
    });
  });
});
