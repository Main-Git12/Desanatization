import { AgentGuard } from './agent-guard.js';

// 3 result pairs => recentPairs.length === 3 (odd). The old code computed
// half === 1.5 and compared recentPairs[1.5] (undefined), so the repeated
// pair at index 2 was never checked. With the even-window fix, the last
// repeated operation must be reported as a cycle.
const guard = new AgentGuard({ durable: false, loopThreshold: 99, cycleThreshold: 2 });

for (let i = 0; i < 3; i++) {
  const id = guard.trackCall('read', { path: 'same.js' });
  guard.trackResult(id, { path: 'same.js', content: 'unchanged' }, true);
}

const report = guard.check();
console.log('pairs window   :', guard.recentPairs.length);
console.log('loopDetected   :', report.loopDetected);
console.log('warnings       :', report.warnings);

if (!report.loopDetected) {
  console.error('FAIL: odd-length cycle was not detected');
  process.exit(1);
}
console.log('PASS: cycle detected across the trimmed even window');
