const express = require('express');
const path = require('path');
const {
  generateWallet,
  estimateDifficulty,
  parsePrefixWords,
  validatePrefixWords,
  isGrinderAvailable,
  defaultThreads,
} = require('./lib/wallet');

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS, 10) || 300_000;

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const jobs = new Map();
let jobCounter = 0;

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'prefix-wallet-gen',
    chain: 'solana',
    grinder: isGrinderAvailable() ? 'rust' : 'node-workers',
    threads: defaultThreads(),
  });
});

app.post('/api/estimate', (req, res) => {
  try {
    const wordCount = parseInt(req.body.wordCount, 10) === 24 ? 24 : 12;
    const prefixWords = parsePrefixWords(req.body.prefix || '');
    validatePrefixWords(prefixWords, wordCount);
    const difficulty = estimateDifficulty(prefixWords, wordCount, {
      addressPrefix: req.body.addressPrefix || '',
      addressSuffix: req.body.addressSuffix || '',
    });

    res.json({
      prefixWords,
      wordCount,
      difficulty,
      grinder: isGrinderAvailable() ? 'rust' : 'node-workers',
      threads: defaultThreads(),
      addressPrefix: (req.body.addressPrefix || '').trim(),
      addressSuffix: (req.body.addressSuffix || '').trim(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

async function runGeneration(jobId, options) {
  try {
    const result = await generateWallet({
      ...options,
      onProgress: ({ attempts, keysPerSec }) => {
        const job = jobs.get(jobId);
        if (job) {
          job.attempts = attempts;
          job.keysPerSec = keysPerSec;
        }
      },
    });

    jobs.set(jobId, {
      status: 'done',
      result,
      finishedAt: Date.now(),
    });
  } catch (err) {
    jobs.set(jobId, { status: 'error', error: err.message, finishedAt: Date.now() });
  }
}

app.post('/api/generate', (req, res) => {
  try {
    const wordCount = parseInt(req.body.wordCount, 10) === 24 ? 24 : 12;
    const account = Math.max(0, parseInt(req.body.account, 10) || 0);
    const maxAttempts = Math.min(50_000_000, Math.max(1000, parseInt(req.body.maxAttempts, 10) || 2_000_000));
    const prefixWords = parsePrefixWords(req.body.prefix || '');
    validatePrefixWords(prefixWords, wordCount);

    const jobId = String(++jobCounter);
    jobs.set(jobId, { status: 'running', attempts: 0, keysPerSec: 0, startedAt: Date.now() });
    res.json({ jobId, status: 'running' });

    setImmediate(() => runGeneration(jobId, {
      prefix: req.body.prefix || '',
      wordCount,
      account,
      addressPrefix: req.body.addressPrefix || '',
      addressSuffix: req.body.addressSuffix || '',
      maxAttempts,
      timeoutMs: Math.min(parseInt(req.body.timeout, 10) || TIMEOUT_MS, 600_000),
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden' });

  if (job.status === 'running') {
    return res.json({
      status: 'running',
      attempts: job.attempts,
      keysPerSec: job.keysPerSec,
    });
  }
  if (job.status === 'error') {
    return res.json({ status: 'error', error: job.error });
  }
  return res.json({ status: 'done', ...job.result });
});

app.post('/api/generate-sync', async (req, res) => {
  try {
    const wordCount = parseInt(req.body.wordCount, 10) === 24 ? 24 : 12;
    const account = Math.max(0, parseInt(req.body.account, 10) || 0);
    const maxAttempts = Math.min(500_000, Math.max(1000, parseInt(req.body.maxAttempts, 10) || 100_000));

    const result = await generateWallet({
      prefix: req.body.prefix || '',
      wordCount,
      account,
      addressPrefix: req.body.addressPrefix || '',
      addressSuffix: req.body.addressSuffix || '',
      maxAttempts,
      timeoutMs: Math.min(parseInt(req.body.timeout, 10) || 120_000, 300_000),
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`prefix-wallet-gen listening on :${PORT}`);
  console.log(`Grinder: ${isGrinderAvailable() ? 'rust (optimized)' : `node workers ×${defaultThreads()}`}`);
});