const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_PATH = path.join(__dirname, 'workers', 'address-grind-worker.js');

function defaultThreads() {
  return Math.max(1, (os.availableParallelism && os.availableParallelism()) || os.cpus().length || 2);
}

function grindAddressParallel(options = {}) {
  const {
    prefix = '',
    suffix = '',
    maxAttempts = 50_000_000,
    threads = defaultThreads(),
    onProgress,
  } = options;

  const wantPrefix = prefix.trim();
  const wantSuffix = suffix.trim();
  if (!wantPrefix && !wantSuffix) {
    return Promise.reject(new Error('Prefix oder Suffix für Vanity-Suche erforderlich.'));
  }

  const threadCount = Math.max(1, Math.min(threads, defaultThreads()));
  const perThread = Math.ceil(maxAttempts / threadCount);
  const start = Date.now();
  let totalAttempts = 0;
  let stopped = false;

  return new Promise((resolve, reject) => {
    let pending = threadCount;
    let winner = null;

    const finish = (err, result) => {
      if (stopped) return;
      stopped = true;
      for (const w of workers) w.terminate();
      if (err) reject(err);
      else resolve(result);
    };

    const workers = Array.from({ length: threadCount }, (_, id) => {
      const worker = new Worker(WORKER_PATH, {
        workerData: {
          workerId: id,
          prefix: wantPrefix,
          suffix: wantSuffix,
          maxAttempts: perThread,
          reportEvery: 5000,
        },
      });

      worker.on('message', (msg) => {
        if (stopped) return;
        if (msg.type === 'progress') {
          totalAttempts += msg.attemptsDelta || 0;
          if (onProgress) {
            const elapsed = (Date.now() - start) / 1000;
            onProgress({
              attempts: totalAttempts,
              keysPerSec: elapsed > 0 ? Math.round(totalAttempts / elapsed) : 0,
            });
          }
        }
        if (msg.type === 'found') {
          winner = {
            ...msg.result,
            attempts: totalAttempts + (msg.result.attempts || 0),
            elapsedMs: Date.now() - start,
            engine: `node-workers×${threadCount}`,
          };
          finish(null, winner);
        }
      });

      worker.on('error', (err) => finish(err));
      worker.on('exit', (code) => {
        pending--;
        if (!stopped && pending === 0 && !winner) {
          finish(new Error('Keine Vanity-Adresse gefunden.'));
        }
        if (code !== 0 && !winner && !stopped) {
          finish(new Error(`Worker beendet mit Code ${code}`));
        }
      });

      return worker;
    });
  });
}

module.exports = { defaultThreads, grindAddressParallel };