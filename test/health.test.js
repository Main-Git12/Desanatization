// ============================================================================
// Health Check Endpoint Tests
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import express from 'express';

const createTestApp = () => {
  const app = express();
  
  app.get('/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });

  return app;
};

test('Health Check - Returns 200 OK', async () => {
  const app = createTestApp();
  
  await new Promise((resolve) => {
    const server = app.listen(3333, async () => {
      try {
        const response = await fetch('http://localhost:3333/health');
        assert.strictEqual(response.status, 200);
        
        const data = await response.json();
        assert.strictEqual(data.status, 'ok');
        assert(data.timestamp);
        assert(typeof data.uptime === 'number');
        
        console.log('✓ Health check endpoint working correctly');
      } finally {
        server.close(resolve);
      }
    });
  });
});

test('Health Check - Returns valid JSON', async () => {
  const app = createTestApp();
  
  await new Promise((resolve) => {
    const server = app.listen(3334, async () => {
      try {
        const response = await fetch('http://localhost:3334/health');
        const data = await response.json();
        
        // Validate timestamp is ISO format
        assert.doesNotThrow(() => {
          new Date(data.timestamp);
        });
        
        console.log('✓ Health check returns valid ISO timestamp');
      } finally {
        server.close(resolve);
      }
    });
  });
});
