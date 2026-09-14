// ============================================================================
// Configuration Validation Tests
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';

test('Config - Valid Ethereum address format check', () => {
  const validAddresses = [
    '0x742d35Cc6634C0532925a3b844Bc9e7595f42b15',
    '0x0000000000000000000000000000000000000000',
    '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'
  ];
  
  const invalidAddresses = [
    '0x742d35Cc6634C0532925a3b844Bc9e7595f42b1',      // Too short
    '0x742d35Cc6634C0532925a3b844Bc9e7595f42b15ab',   // Too long
    '742d35Cc6634C0532925a3b844Bc9e7595f42b15',       // Missing 0x
    '0xGGGGGGCc6634C0532925a3b844Bc9e7595f42b15',     // Invalid hex
    ''
  ];

  function isValidEthereumAddress(address) {
    if (!address) return false;
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  validAddresses.forEach(addr => {
    assert(isValidEthereumAddress(addr), `Should accept valid address: ${addr}`);
  });
  
  invalidAddresses.forEach(addr => {
    assert(!isValidEthereumAddress(addr), `Should reject invalid address: ${addr}`);
  });
  
  console.log('✓ Ethereum address validation working correctly');
});

test('Config - Valid URL format check', () => {
  const validUrls = [
    'http://localhost:3001',
    'https://facilitator.example.com',
    'http://192.168.1.1:3001',
    'https://example.com/path'
  ];
  
  const invalidUrls = [
    'not-a-url',
    'htp://wrong-scheme.com',
    ''
  ];

  validUrls.forEach(url => {
    assert.doesNotThrow(() => {
      new URL(url);
    }, `Should accept valid URL: ${url}`);
  });
  
  invalidUrls.forEach(url => {
    assert.throws(() => {
      new URL(url);
    }, `Should reject invalid URL: ${url}`);
  });
  
  console.log('✓ URL validation working correctly');
});

test('Config - Valid port range check', () => {
  const isValidPort = (port) => port >= 1 && port <= 65535;
  
  assert(isValidPort(3000));
  assert(isValidPort(1));
  assert(isValidPort(65535));
  assert(!isValidPort(0));
  assert(!isValidPort(65536));
  
  console.log('✓ Port validation working correctly');
});
