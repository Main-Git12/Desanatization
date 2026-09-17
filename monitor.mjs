const PROD_URL = 'https://desanatization-production-e133.up.railway.app';
const LOCAL_URL = 'http://localhost:3000';
let lastReceiptCount = 0;

async function checkServer(url, name) {
  const results = { name, timestamp: new Date().toISOString() };
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10000) });
    results.health = res.status;
    if (res.ok) {
      const data = await res.json();
      results.up = data.status === 'ok';
      results.uptime = data.uptimeSeconds;
    }
  } catch (e) {
    results.health = 'error';
    results.error = e.message;
  }

  // Check receipts
  try {
    const res = await fetch(`${url}/receipts`, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      results.receipts = data.count;
      if (name === 'production' && data.count > lastReceiptCount) {
        results.NEW_SALE = true;
        lastReceiptCount = data.count;
        console.log(`🔔 SALE ALERT: ${data.count} receipts on ${name}`);
      }
    }
  } catch (e) {
    results.receiptsError = e.message;
  }

  return results;
}

async function runCheck() {
  const prods = await checkServer(PROD_URL, 'production');
  const locals = await checkServer(LOCAL_URL, 'local');
  console.log(`[${new Date().toISOString()}] Monitor:`, JSON.stringify({ prod: prods, local: locals }));
}

// Run immediately, then every 30 seconds
await runCheck();
setInterval(runCheck, 30000);
