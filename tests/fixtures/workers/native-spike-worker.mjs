/**
 * A worker held in ONE native call that allocates (4.H-a, #57 item 7): a
 * synchronous spawn collecting its child's output into memory and then waiting
 * for it. Its heap read cannot be answered while the call runs, so only a
 * watchdog that reads the process's own memory can stop it before the
 * deadline. The output size comes from workerData; nothing reaches a network.
 */
import { execFileSync } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';

// `exec` replaces the shell with the sleep, so the pid written is the process the test ends (a terminated worker
// cannot leave a native call: the call must end for the thread to stop).
const script = `echo $$ > "$0"; head -c ${Number(workerData.bytes)} /dev/zero; exec sleep ${Number(workerData.holdSeconds)}`;
const out = execFileSync('sh', ['-c', script, String(workerData.pidFile)], { maxBuffer: Number(workerData.bytes) * 2 });
parentPort.postMessage({ ok: true, length: out.length });
