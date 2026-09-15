import { x402Client } from '@x402/core/client';
import { x402HTTPClient } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import crypto from 'crypto';

async function runClient() {
  const derString = 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQggWuCh4QVDld5h/Fa1DHHW5V1cps/zKhvnflQ4lLxNxWhRANCAAR0GCIwm64bsAJJ1uA5WD4dMs9ERR+xVW0j1prz/wbYQGoIoGe+wWJzrDRLYv/0g89be5PD+1FdCJmWMAnMQzh0';
  const derBuffer = Buffer.from(derString, 'base64');
  const keyObject = crypto.createPrivateKey({
    key: derBuffer,
    format: 'der',
    type: 'sec1',
  });
  const jwk = keyObject.export({ format: 'jwk' });
  const clientPrivateKey = '0x' + Buffer.from(jwk.d, 'base64').toString('hex');
  
  const account = privateKeyToAccount(clientPrivateKey);
  console.log(`Client Wallet Address: ${account.address}`);

  const coreClient = x402Client.fromConfig({
    schemes: [
      {
        network: 'eip155:8453',
        client: new ExactEvmScheme(account),
      },
    ],
    spendControls: false,
  });

  const httpClient = new x402HTTPClient(coreClient);

  const targetUrl = 'https://desanatization-production.up.railway.app/api/resource';
  console.log(`Sending request to live server at ${targetUrl}...`);

  try {
    let response = await fetch(targetUrl);

    if (response.status === 402) {
      console.log('Received 402 Payment Required. Processing mainnet payment challenge & signing...');
      
      const paymentRequired = httpClient.getPaymentRequiredResponse(
        (name) => response.headers.get(name),
        await response.json()
      );

      const paymentPayload = await coreClient.createPaymentPayload(paymentRequired);
      
      response = await fetch(targetUrl, {
        headers: httpClient.encodePaymentSignatureHeader(paymentPayload),
      });
    }

    const data = await response.json();
    console.log('Success! Live response from server:', data);
  } catch (error) {
    console.error('Mainnet payment or request failed:', error);
  }
}

runClient();
