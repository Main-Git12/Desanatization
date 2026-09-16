#!/usr/bin/env node
// ============================================================================
// Log Review & Performance Monitor
//
// Parses server log output (stdout/stderr from index.js) for performance and
// revenue signals that are not visible from the HTTP metrics endpoints alone:
//
//   - 5xx error bursts (paywall or facilitator instability)
//   - 402-to-200 conversion (are buyers completing payments?)
//   - slow request threshold breaches
//   - growth engine cycle outcomes
//   - agent task success/failure ratio
//   - notification delivery results
//
// Usage:
//   node scripts/log-review.mjs                        # reads server.out.log + server.err.log
//   node scripts/log-review.mjs path/to/server.log
//   node scripts/log-review.mjs --live                  # tail + analyze (Railway)
//
// Exit code 0 = no anomalies detected; 1 = anomalies found (fix recommended).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_LOGS = ['server.out.log', 'server.err.log'];
const ERROR_LOG_PATH = 'server.err.log';
const SLOW_THRESHOLD_MS = 5000;

/** ANSI colors for terminal output. */
const C = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m', bold: '\x1b[1m', reset: '\x1b[0m' };

/**
 * @typedef {Object} LogEntry
 * @property {string} raw - The raw log line
 * @property {Date} timestamp - Parsed timestamp
 * @property {string} level - log level (error, warn, info, debug)
 * @property {string} namespace - logger namespace
 * @property {string} message - log message
 */

/**
 * Parse a single server log line into a structured entry.
 *
 * @param {string} line - Raw log line
 * @returns {LogEntry|null} Parsed entry or null for unparseable lines
 */
function parseLogLine(line) {
  if (!line || !line.trim()) return null;
  // Format: [ISO] [LEVEL] [NAMESPACE] message
  const match = line.match(/^\[([^\]]+)\] \[(\w+)\] \[([^\]]+)\] (.*)$/);
  if (!match) return null;
  const [, ts, level, namespace, message] = match;
  try {
    return { raw: line, timestamp: new Date(ts), level, namespace, message };
  } catch {
    return null;
  }
}

/**
 * Read and parse log files.
 *
 * @param {string[]} files - Log file paths
 * @returns {LogEntry[]} Parsed entries
 */
function readLogs(files) {
  const entries = [];
  for (const file of files) {
    const fullPath = path.resolve(file);
    if (!fs.existsSync(fullPath)) {
      console.warn(`${C.yellow}WARN: ${file} not found — skipping.${C.reset}`);
      continue;
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    for (const line of content.split('\n')) {
      const entry = parseLogLine(line);
      if (entry) entries.push(entry);
    }
  }
  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Review log entries for performance and revenue anomalies.
 *
 * @param {LogEntry[]} entries - Parsed log entries
 * @returns {Object} Analysis results
 */
function analyzeLogs(entries) {
  const results = {
    totalLines: entries.length,
    errors: [],
    warnings: [],
    slowRequests: [],
    paywallEvents: { challenged: 0, settled: 0, failed: 0 },
    growthCycles: 0,
    agentTasks: { succeeded: 0, failed: 0, replayed: 0, learned: 0 },
    notifications: { sent: 0, failed: 0 },
    anomalies: [],
  };

  for (const entry of entries) {
    // Error-level log lines
    if (entry.level === 'error') {
      results.errors.push(entry);
      // Flag unhandled rejections and uncaught exceptions
      if (entry.message.includes('Unhandled promise rejection') || entry.message.includes('Uncaught exception')) {
        results.anomalies.push({
          severity: 'critical',
          message: `Unhandled error: ${entry.message}`,
          timestamp: entry.timestamp.toISOString(),
        });
      }
    }

    // Warnings
    if (entry.level === 'warn') {
      results.warnings.push(entry);
      if (entry.message.includes('Rate limit exceeded')) {
        results.anomalies.push({
          severity: 'warn',
          message: entry.message,
          timestamp: entry.timestamp.toISOString(),
        });
      }
    }

    // Payment events
    if (entry.message.includes('Payment settled')) {
      results.paywallEvents.settled++;
    }
    if (entry.message.includes('402') || entry.message.includes('Payment required')) {
      results.paywallEvents.challenged++;
    }
    if (entry.message.includes('Payment failure') || entry.message.includes('failedPayments')) {
      results.paywallEvents.failed++;
    }

    // Slow requests
    const slowMatch = entry.message.match(/took (\d+)ms/);
    if (slowMatch) {
      const ms = parseInt(slowMatch[1], 10);
      if (ms > SLOW_THRESHOLD_MS) {
        results.slowRequests.push({ ms, path: entry.message, timestamp: entry.timestamp });
      }
    }
    // Express-style slow request logs
    const expressMatch = entry.message.match(/-> (\d+) in (\d+)ms/);
    if (expressMatch) {
      const ms = parseInt(expressMatch[2], 10);
      if (ms > SLOW_THRESHOLD_MS) {
        results.slowRequests.push({ ms, path: entry.message, timestamp: entry.timestamp });
      }
    }

    // Growth engine
    if (entry.message.includes('Growth cycle')) {
      results.growthCycles++;
    }

    // Agent tasks
    if (entry.message.includes('skill-replay')) {
      results.agentTasks.replayed++;
      results.agentTasks.succeeded++;
    } else if (entry.message.includes('skill-learned')) {
      results.agentTasks.learned++;
      results.agentTasks.succeeded++;
    } else if (entry.message.includes('skill-drift')) {
      results.agentTasks.failed++;
    }

    // Notifications
    if (entry.message.includes('email sent') || entry.message.includes('notify[')) {
      results.notifications.sent++;
    }
    if (entry.message.includes('webhook') && entry.level === 'warn') {
      results.notifications.failed++;
    }
  }

  // Anomaly: high error rate
  if (results.errors.length > 10) {
    results.anomalies.push({
      severity: 'critical',
      message: `High error volume: ${results.errors.length} error-level log lines`,
      timestamp: new Date().toISOString(),
    });
  }

  // Anomaly: payment conversion
  const totalAttempts = results.paywallEvents.challenged + results.paywallEvents.settled;
  if (totalAttempts > 0) {
    const conversionRate = results.paywallEvents.settled / totalAttempts;
    if (conversionRate < 0.1 && totalAttempts > 5) {
      results.anomalies.push({
        severity: 'warn',
        message: `Low payment conversion: ${Number((conversionRate * 100).toFixed(1))}% (${results.paywallEvents.settled}/${totalAttempts})`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Anomaly: failed payments
  if (results.paywallEvents.failed > 0) {
    results.anomalies.push({
      severity: 'info',
      message: `${results.paywallEvents.failed} payment attempts were rejected`,
      timestamp: new Date().toISOString(),
    });
  }

  // Anomaly: no growth cycles in 24h
  if (results.growthCycles === 0 && entries.length > 0) {
    const newest = entries[entries.length - 1].timestamp;
    const oldest = entries[0].timestamp;
    const spanHours = (newest - oldest) / (1000 * 60 * 60);
    if (spanHours > 2) {
      results.anomalies.push({
        severity: 'warn',
        message: `No growth engine cycles logged in ${Number(spanHours.toFixed(1))}h of logs`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return results;
}

/**
 * Print a summary report to the console.
 *
 * @param {Object} results - Analysis results
 */
function printReport(results) {
  console.log(`\n${C.bold}=== Desanatization Log Review ===${C.reset}\n`);
  console.log(`Total log entries analyzed: ${results.totalLines}`);

  console.log(`\n${C.cyan}--- Payment Flow ---${C.reset}`);
  console.log(`  402 challenges: ${results.paywallEvents.challenged}`);
  console.log(`${C.green}  Settled:        ${results.paywallEvents.settled}${C.reset}`);
  if (results.paywallEvents.failed > 0) {
    console.log(`${C.yellow}  Failed:         ${results.paywallEvents.failed}${C.reset}`);
  }

  console.log(`\n${C.cyan}--- Growth Engine ---${C.reset}`);
  console.log(`  Cycles run: ${results.growthCycles}`);

  console.log(`\n${C.cyan}--- Task Agent ---${C.reset}`);
  console.log(`  Succeeded: ${results.agentTasks.succeeded} | Replayed: ${results.agentTasks.replayed} | Learned: ${results.agentTasks.learned} | Failed: ${results.agentTasks.failed}`);

  console.log(`\n${C.cyan}--- Notifications ---${C.reset}`);
  console.log(`  Sent: ${results.notifications.sent} | Failed: ${results.notifications.failed}`);

  if (results.slowRequests.length > 0) {
    console.log(`\n${C.yellow}--- Slow Requests (>${SLOW_THRESHOLD_MS}ms) ---${C.reset}`);
    for (const req of results.slowRequests.slice(0, 10)) {
      console.log(`  ${req.timestamp.toISOString()} — ${req.ms}ms — ${req.path.slice(0, 120)}`);
    }
  }

  if (results.anomalies.length > 0) {
    console.log(`\n${C.bold}--- Anomalies ---${C.reset}`);
    for (const anomaly of results.anomalies) {
      const color = anomaly.severity === 'critical' ? C.red : anomaly.severity === 'warn' ? C.yellow : C.cyan;
      console.log(`  ${color}[${anomaly.severity.toUpperCase()}]${C.reset} ${anomaly.message}`);
    }
  }

  const critical = results.anomalies.filter((a) => a.severity === 'critical');
  if (critical.length > 0) {
    console.log(`\n${C.red}${C.bold}FAIL${C.reset} — ${critical.length} critical anomaly(ies) detected.`);
  } else if (results.anomalies.length > 0) {
    console.log(`\n${C.yellow}${C.bold}WARN${C.reset} — ${results.anomalies.length} non-critical anomaly(ies).`);
  } else {
    console.log(`\n${C.green}${C.bold}OK${C.reset} — no anomalies detected.`);
  }
}

/**
 * Tail a file and process new lines as they arrive (for live monitoring).
 *
 * @param {string} filePath - File to tail
 * @param {Function} callback - Called with each batch of new entries
 */
function tailFile(filePath, callback) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }
  let lastSize = 0;
  const interval = setInterval(() => {
    const stats = fs.statSync(filePath);
    if (stats.size > lastSize) {
      const stream = fs.createReadStream(filePath, { start: lastSize, encoding: 'utf8' });
      let buffer = '';
      stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const entry = parseLogLine(line);
          if (entry) callback([entry]);
        }
      });
      lastSize = stats.size;
    }
  }, 2000);
  process.on('SIGINT', () => {
    clearInterval(interval);
    process.exit(0);
  });
}

// --- Entry point ---
const args = process.argv.slice(2);
const liveMode = args.includes('--live');
const files = args.filter((a) => !a.startsWith('-'));

if (liveMode) {
  // Live monitoring: tail the default log files and report anomalies in real time.
  const targets = files.length > 0 ? files : [path.resolve(ERROR_LOG_PATH)];
  console.log(`Live monitoring: ${targets.join(', ')} (Ctrl+C to stop)\n`);
  tailFile(targets[0], (entries) => {
    const results = analyzeLogs(entries);
    if (results.anomalies.length > 0) {
      for (const a of results.anomalies) {
        const color = a.severity === 'critical' ? C.red : a.severity === 'warn' ? C.yellow : C.cyan;
        console.log(`[${new Date().toISOString()}] ${color}[${a.severity}]${C.reset} ${a.message}`);
      }
    }
  });
} else {
  // Batch analysis: parse and report.
  const logFiles = files.length > 0 ? files : DEFAULT_LOGS;
  const entries = readLogs(logFiles);
  if (entries.length === 0) {
    console.error(`${C.red}No parseable log entries found in ${logFiles.join(', ')}${C.reset}`);
    process.exit(1);
  }
  const results = analyzeLogs(entries);
  printReport(results);
  const critical = results.anomalies.filter((a) => a.severity === 'critical');
  process.exit(critical.length > 0 ? 1 : 0);
}
