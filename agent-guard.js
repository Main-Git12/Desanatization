// ============================================================================
// Agent Guard — anti-loop / anti-hallucination middleware for AI coding agents
//
// Wraps a tool-use session to:
//   1. Detect loops  — the agent repeats the same tool call (or short cycle)
//      without making forward progress.
//   2. Detect hallucinations — the agent claims something that contradicts a
//      tool result it already holds.
//   3. Persist a per-task learning log so every interaction teaches the agent
//      (and future agents) what worked and what didn't.
//
// The guard is intentionally side-effect-free on the happy path: it observes
// and warns, it does not forcibly terminate. The calling agent decides what
// to do with the feedback. This keeps it safe to drop into any existing agent
// loop (Kilo, Cline, Claude-Code, OpenHands, etc.).
// ============================================================================

import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Default directory for per-task interaction logs. */
const DEFAULT_LOG_DIR = join(process.cwd(), '.kilo', 'agent-guard');

/** Default options — can be overridden per-session or via env at import time. */
const DEFAULTS = {
  maxIterations: 80,
  /** Consecutive identical tool calls that trigger loop suspicion. */
  loopThreshold: 3,
  /** Consecutive identical tool-result pairs that trigger a deeper loop. */
  cycleThreshold: 2,
  /** Number of prior sessions to scan when building the "what worked" cache. */
  learnFromPastSessions: 50,
  logDir: DEFAULT_LOG_DIR,
  /** Max entries to keep in the in-memory log (older entries are flushed to disk). */
  maxInMemory: 200,
};

/**
 * Normalize a tool-call argument object into a comparable signature.
 * Strips volatile fields (timestamps, UUIDs, file paths that change per-run)
 * so the same logical action is recognised across cycles.
 *
 * @param {string} toolName
 * @param {object} args
 * @returns {string}
 */
function signature(toolName, args) {
  if (!args || typeof args !== 'object') return toolName;
  const clone = {};
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'string' && v.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) continue;
    clone[k] = v;
  }
  return `${toolName}:${JSON.stringify(clone)}`;
}

/**
 * Summarize a tool result for logging without storing full file contents.
 *
 * @param {*} result
 * @returns {object}
 */
function summarizeResult(result) {
  if (result === null || result === undefined) return { type: 'null' };
  if (typeof result === 'string') {
    return { type: 'string', length: result.length, preview: result.slice(0, 120) };
  }
  if (typeof result === 'object') {
    if (Array.isArray(result)) return { type: 'array', length: result.length };
    return { type: 'object', keys: Object.keys(result).slice(0, 10) };
  }
  return { type: typeof result, value: String(result).slice(0, 80) };
}

/**
 * @typedef {object} ToolCallEntry
 * @property {string} id
 * @property {string} tool
 * @property {object} args
 * @property {string} signature
 * @property {number} index  — sequential call index
 * @property {number} timestamp
 */

/**
 * @typedef {object} ResultEntry
 * @property {string} callId
 * @property {string} tool
 * @property {object} summary
 * @property {boolean} ok
 * @property {number} timestamp
 */

/**
 * @typedef {object} ClaimEntry
 * @property {string} text — the claimed statement
 * @property {string} source — which tool call / reasoning step it came from
 * @property {number} timestamp
 * @property {'fact'|'plan'|'prediction'|'result'} type
 */

/**
 * @typedef {object} GuardReport
 * @property {boolean} loopDetected
 * @property {boolean} hallucinationDetected
 * @property {boolean} maxIterationsReached
 * @property {boolean} noForwardProgress
 * @property {Array<object>} warnings
 * @property {object} state
 */

/**
 * The guard wraps every tool invocation and result in a session. Create one
 * per task (or per agent conversation) and feed it every tool call / result
 * / claim the agent makes.
 */
export class AgentGuard {
  /**
   * @param {object} [opts]
   * @param {string} [opts.sessionId] — auto-generated if omitted
   * @param {string} [opts.task] — human-readable task description
   * @param {string} [opts.logDir]
   * @param {number} [opts.maxIterations]
   * @param {number} [opts.loopThreshold]
   * @param {number} [opts.cycleThreshold]
   * @param {number} [opts.learnFromPastSessions]
   * @param {boolean} [opts.durable] — persist interaction log to disk
   */
  constructor(opts = {}) {
    this.sessionId = opts.sessionId ?? randomUUID();
    this.task = opts.task ?? 'unnamed-task';
    this.opts = { ...DEFAULTS, ...opts };
    this.opts.logDir = this.opts.logDir ?? DEFAULT_LOG_DIR;

    /** @type {ToolCallEntry[]} */
    this.calls = [];
    /** @type {ResultEntry[]} */
    this.results = [];
    /** @type {ClaimEntry[]} */
    this.claims = [];
    /** @type {number} */
    this.iteration = 0;
    /** @type {Set<string>} */
    this.seenSignatures = new Set();
    /** @type {Set<string>} */
    this.knownFacts = new Set();
    /** @type {Array<{tool:string,args:object,result:object,time:number}>} */
    this.recentPairs = [];
    /** @type {object|null} */
    this.lastLoopReport = null;
    this.durable = opts.durable ?? false;

    this._loadLearning();
  }

  /* ── Learning from past sessions ─────────────────────────────────────── */

  _sessionPath() {
    return join(this.opts.logDir, `${this.sessionId}.jsonl`);
  }

  _indexPath() {
    return join(this.opts.logDir, 'index.json');
  }

  _loadLearning() {
    if (!this.durable) return;
    try {
      mkdirSync(this.opts.logDir, { recursive: true });
      const idxPath = this._indexPath();
      try {
        const raw = readFileSync(idxPath, 'utf8');
        const idx = JSON.parse(raw);
        idx.sessions = idx.sessions ?? [];
        idx.sessions = idx.sessions
          .filter((s) => typeof s === 'object' && s.sessionId)
          .slice(-this.opts.learnFromPastSessions);
        this._sessionIndex = idx.sessions;
      } catch {
        this._sessionIndex = [];
      }
    } catch {
      this._sessionIndex = [];
    }
  }

  _appendLog(entry) {
    if (!this.durable) return;
    try {
      appendFileSync(this._sessionPath(), JSON.stringify(entry) + '\n');
    } catch {
      // Best-effort — never fatal.
    }
  }

  _flushIndex() {
    if (!this.durable) return;
    try {
      const idxPath = this._indexPath();
      let idx;
      try {
        idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      } catch {
        idx = { sessions: [] };
      }
      idx.sessions = idx.sessions ?? [];
      idx.sessions = idx.sessions.filter((s) => s.sessionId !== this.sessionId);
      idx.sessions.push({
        sessionId: this.sessionId,
        task: this.task,
        createdAt: new Date().toISOString(),
        iterations: this.iteration,
        toolsUsed: [...new Set(this.calls.map((c) => c.tool))],
        warnings: this.lastLoopReport ? [this.lastLoopReport] : [],
      });
      idx.sessions = idx.sessions.slice(-this.opts.learnFromPastSessions);
      writeFileSync(idxPath, JSON.stringify(idx, null, 2));
    } catch {
      // Best-effort.
    }
  }

  /**
   * @returns {Array<object>} Recent sessions that used the same tools.
   */
  similarSessions(toolNames) {
    if (!this._sessionIndex) return [];
    const set = new Set(toolNames);
    return this._sessionIndex
      .filter((s) => (s.toolsUsed ?? []).some((t) => set.has(t)))
      .slice(-5);
  }

  /* ── Tool-call tracking ──────────────────────────────────────────────── */

  /**
   * Record a tool call. Call immediately before the tool executes.
   *
   * @param {string} toolName
   * @param {object} args
   * @returns {string} callId — pass this back to trackResult()
   */
  trackCall(toolName, args = {}) {
    const callId = randomUUID();
    const sig = signature(toolName, args);
    this.iteration += 1;
    const entry = {
      id: callId,
      tool: toolName,
      args: args,
      signature: sig,
      index: this.iteration,
      timestamp: Date.now(),
    };
    this.calls.push(entry);
    this._appendLog({ type: 'call', ...entry });
    return callId;
  }

  /**
   * Record the result of the most recent tool call.
   *
   * @param {string} callId
   * @param {*} result
   * @param {boolean} [ok]
   */
  trackResult(callId, result, ok = true) {
    const call = this.calls.find((c) => c.id === callId);
    if (!call) return;
    const summary = summarizeResult(result);
    const entry = {
      callId,
      tool: call.tool,
      summary,
      ok,
      timestamp: Date.now(),
    };
    this.results.push(entry);
    this._appendLog({ type: 'result', ...entry });

    // Maintain a rolling window of call+result pairs for cycle detection.
    this.recentPairs.push({
      tool: call.tool,
      args: call.args,
      result: summary,
      time: entry.timestamp,
    });
    // eslint-disable-next-line no-console
    if (process.env.GUARD_DEBUG_PAIRS) console.log('[guard] pairs', this.recentPairs.length, maxPairsProbe(this.opts));
    // Keep the window truncated to an even length: cycle detection compares
    // two equal halves, and an odd count leaves a pair in neither half.
    const maxPairs = this.opts.cycleThreshold * 2;
    while (this.recentPairs.length > maxPairs) {
      this.recentPairs.shift();
    }

    // If the result contains a concrete fact, remember it.
    if (ok && typeof result === 'object' && result !== null) {
      if (typeof result.path === 'string') this.knownFacts.add(`exists:${result.path}`);
      if (typeof result.url === 'string') this.knownFacts.add(`url:${result.url}`);
    }
  }

  /**
   * Record a claim the agent makes in its reasoning or output.
   *
   * @param {string} text
   * @param {string} source
   * @param {'fact'|'plan'|'prediction'|'result'} [type]
   */
  recordClaim(text, source = 'output', type = 'fact') {
    if (!text || typeof text !== 'string' || text.trim().length < 10) return null;
    const entry = { text: text.trim(), source, type, timestamp: Date.now() };
    this.claims.push(entry);
    this._appendLog({ type: 'claim', ...entry });
    return entry;
  }

  /**
   * Check the current session state and return a report.
   *
   * @returns {GuardReport}
   */
  check() {
    const warnings = [];
    let loopDetected = false;
    let hallucinationDetected = false;
    let noForwardProgress = false;
    const maxIterationsReached = this.iteration > this.opts.maxIterations;

    if (maxIterationsReached) {
      warnings.push(`Maximum iterations reached (${this.iteration}). Consider re-planning.`);
    }

    // ── Loop detection: consecutive identical signatures ──
    const sigs = this.calls.map((c) => c.signature);
    for (let i = this.opts.loopThreshold; i <= sigs.length; i++) {
      const window = sigs.slice(i - this.opts.loopThreshold, i);
      if (window.every((s) => s === window[0])) {
        loopDetected = true;
        const call = this.calls[i - 1];
        const msg = `Loop detected: tool "${call.tool}" called ${this.opts.loopThreshold} consecutive times with identical arguments.`;
        warnings.push(msg);
        this.lastLoopReport = { type: 'loop', message: msg, tool: call.tool, signature: call.signature };
        break;
      }
    }

    // ── Cycle detection: identical (tool+args -> result) pairs ──
    // Compare two non-overlapping equal-sized windows. A fractional split
    // (odd pair count) would index a non-integer position and compare
    // undefined against a real pair, silently missing real cycles — so trim
    // the window to an even length first.
    const window = this.recentPairs.length - (this.recentPairs.length % 2);
    if (!loopDetected && window >= this.opts.cycleThreshold * 2) {
      const half = window / 2;
      for (let i = 0; i < half; i++) {
        const a = this.recentPairs[i];
        const b = this.recentPairs[i + half];
        const sameOp =
          a.tool === b.tool && JSON.stringify(a.args) === JSON.stringify(b.args);
        const sameResult =
          JSON.stringify(a.result) === JSON.stringify(b.result);
        if (sameOp && sameResult) {
          loopDetected = true;
          const msg = `Cycle detected: ${a.tool} produced the same result twice in a row — the agent is spinning.`;
          warnings.push(msg);
          this.lastLoopReport = {
            type: 'cycle',
            message: msg,
            tool: a.tool,
          };
          break;
        }
      }
    }

    // ── No-forward-progress: same set of files touched repeatedly ──
    if (!loopDetected) {
      const fileOps = this.calls
        .filter((c) => c.tool === 'read' || c.tool === 'write' || c.tool === 'edit')
        .map((c) => c.args.path ?? c.args.filePath ?? c.args.file);
      const distinct = new Set(fileOps).size;
      const total = fileOps.length;
      if (total >= 8 && distinct === 1 && total / this.opts.loopThreshold >= 2) {
        noForwardProgress = true;
        const msg = `No forward progress: ${total} tool calls all touch the same file "${fileOps[0]}".`;
        warnings.push(msg);
        this.lastLoopReport = { type: 'stuck', message: msg, file: fileOps[0] };
      }
    }

    // ── Hallucination detection ──
    // A claim is suspicious if it asserts a file/URL exists but we have
    // no "exists:" fact for it, or if it contradicts a known result.
    const recentClaims = this.claims.slice(-20);
    for (const claim of recentClaims) {
      const text = claim.text.toLowerCase();

      // "I've created file X" — check we don't have a contradictory result.
      const createdMatch = text.match(/i (?:created|wrote|saved|edited) .*?([\w./\\]+\.\w+)/);
      if (createdMatch) {
        const path = createdMatch[1];
        // Look through recent results for this file.
        const relevantResult = this.results
          .slice(-10)
          .find(
            (r) =>
              typeof r.summary.keys === 'object' &&
              r.summary.keys?.some((k) => k.includes(path)),
          );
        if (relevantResult && !relevantResult.ok) {
          hallucinationDetected = true;
          warnings.push(
            `Hallucination: agent claimed to write "${path}" but a recent tool result for that file was an error.`,
          );
          break;
        }
      }

      // "I verified that X" — check whether a read/search actually happened.
      const verifiedMatch = text.match(/i (?:verified|confirmed) .*?([\w./\\]+)/);
      if (verifiedMatch) {
        const path = verifiedMatch[1];
        const found = this.calls.some(
          (c) =>
            (c.tool === 'read' || c.tool === 'glob' || c.tool === 'grep') &&
            JSON.stringify(c.args).includes(path),
        );
        if (!found) {
          hallucinationDetected = true;
          warnings.push(
            `Hallucination: agent claims to have verified "${path}" but no read/glob/grep call for it was recorded.`,
          );
          break;
        }
      }
    }

    // ── Learning signal: warn if similar sessions failed ──
    const toolsUsed = [...new Set(this.calls.map((c) => c.tool))];
    const similar = this.similarSessions(toolsUsed);
    if (similar.length > 0 && maxIterationsReached) {
      const failed = similar.filter((s) => s.warnings?.length > 0);
      if (failed.length > 0) {
        warnings.push(
          `Pattern alert: ${failed.length} similar past session(s) also failed. Consider a different approach.`,
        );
      }
    }

    const report = {
      loopDetected,
      hallucinationDetected,
      maxIterationsReached,
      noForwardProgress,
      warnings,
      state: {
        iterations: this.iteration,
        calls: this.calls.length,
        results: this.results.length,
        claims: this.claims.length,
        knownFacts: this.knownFacts.size,
        similarSessions: similar.length,
      },
    };

    this._appendLog({ type: 'check', ...report });
    return report;
  }

  /**
   * Run a check and, if problems are found, return a structured
   * suggestion the agent can feed back into its reasoning loop.
   *
   * @returns {object}
   */
  diagnose() {
    const report = this.check();
    if (report.loopDetected || report.hallucinationDetected || report.maxIterationsReached) {
      return {
        ...report,
        suggestion: this._suggestRecovery(),
      };
    }
    return report;
  }

  /** @returns {string} */
  _suggestRecovery() {
    const reports = this.lastLoopReport;
    if (reports?.type === 'loop') {
      return `STOP repeating "${reports.tool}". Re-read the error/output and try a DIFFERENT approach — e.g., change the function you’re calling, modify your arguments, or split the task into smaller sub-steps.`;
    }
    if (reports?.type === 'cycle') {
      return `The same action is producing the same result. Step back: inspect what actually changed, or pivot to a different tool entirely.`;
    }
    if (reports?.type === 'stuck') {
      return `You have made ${this.iteration} calls all touching "${reports.file}". This is not progress — re-read the file, identify the actual blocker, or ask for clarification.`;
    }
    if (this.iteration > this.opts.maxIterations) {
      return `You have run ${this.iteration} iterations. Summarize what you’ve learned, write down the remaining plan, and start fresh on the next step only.`;
    }
    if (this.claims.length > 0) {
      const lastClaim = this.claims[this.claims.length - 1];
      return `Your claim "${lastClaim.text.slice(0, 80)}…" is not backed by any recorded tool call. Verify before asserting.`;
    }
    return 'Continue carefully and verify each claim against tool output.';
  }

  /**
   * Call once when the task ends (whether success or failure) to
   * persist the learning log and update the session index.
   */
  finish() {
    if (this.durable) {
      this._flushIndex();
    }
  }
}

/**
 * Convenience: create a JSON-stringify-safe snapshot of the guard state
 * suitable for injecting back into the agent’s context window as a
 * "what I know so far" refresher.
 *
 * @param {AgentGuard} guard
 * @returns {string}
 */
export function contextSnapshot(guard) {
  const recent = guard.calls.slice(-8).map((c) => ({
    tool: c.tool,
    argsPreview: JSON.stringify(c.args).slice(0, 100),
  }));
  const facts = [...guard.knownFacts].slice(-10);
  const recentResults = guard.results.slice(-5).map((r) => ({
    tool: r.tool,
    ok: r.ok,
    summary: r.summary,
  }));
  const report = guard.lastLoopReport;
  const warnings = report ? [`LAST WARNING: ${report.message}`] : [];
  return [
    `# Session snapshot (guard)`,
    `- Iteration: ${guard.iteration}/${guard.opts.maxIterations}`,
    `- Tools used: ${[...new Set(guard.calls.map((c) => c.tool))].join(', ') || 'none'}`,
    `- Known facts: ${facts.length > 0 ? facts.join(', ') : 'none'}`,
    `- Recent calls: ${JSON.stringify(recent, null, 0)}`,
    `- Recent results: ${JSON.stringify(recentResults, null, 0)}`,
    warnings.length ? `- ⚠️ ${warnings.join('\n- ⚠️ ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export { DEFAULTS };
