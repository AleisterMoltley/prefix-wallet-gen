const express = require('express');
const path = require('path');
const {
  generateWallet,
  estimateDifficulty,
  parsePrefixWords,
  validatePrefixWords,
} = require('./lib/wallet');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const jobs = new Map();
let jobCounter = 0;

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'prefix-wallet-gen', chain: 'solana' });
});

app.post('/api/estimate', (req, res) => {
  try {
    const wordCount = parseInt(req.body.wordCount, 10) === 24 ? 24 : 12;
    const prefixWords = parsePrefixWords(req.body.prefix || '');
    validatePrefixWords(prefixWords, wordCount);
    const difficulty = estimateDifficulty(prefixWords, wordCount);
    const addressPrefix = (req.body.addressPrefix || '').trim();

    res.json({
      prefixWords,
      wordCount,
      difficulty,
      addressPrefix,
      addressNote: addressPrefix
        ? `Adress-Prefix "${addressPrefix}" kann viele Versuche brauchen (58^${addressPrefix.length} im Worst Case).`
        : null,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/generate', (req, res) => {
  try {
    const wordCount = parseInt(req.body.wordCount, 10) === 24 ? 24 : 12;
    const account = Math.max(0, parseInt(req.body.account, 10) || 0);
    const maxAttempts = Math.min(50_000_000, Math.max(1000, parseInt(req.body.maxAttempts, 10) || 2_000_000));
    const prefixWords = parsePrefixWords(req.body.prefix || '');
    validatePrefixWords(prefixWords, wordCount);

    const jobId = String(++jobCounter);
    jobs.set(jobId, { status: 'running', attempts: 0, startedAt: Date.now() });

    res.json({ jobId, status: 'running' });

    setImmediate(() => {
      try {
        const result = generateWallet({
          prefix: req.body.prefix || '',
          wordCount,
          account,
          addressPrefix: req.body.addressPrefix || '',
          maxAttempts,
          onProgress: ({ attempts }) => {
            const job = jobs.get(jobId);
            if (job) job.attempts = attempts;
          },
        });

        jobs.set(jobId, {
          status: 'done',
          result: {
            chain: 'solana',
            mnemonic: result.mnemonic,
            address: result.address,
            secretKeyBase58: result.secretKeyBase58,
            attempts: result.attempts,
            method: result.method,
            derivationPath: result.derivationPath,
            account: result.account,
            wordCount: result.wordCount,
            prefixWords: result.prefixWords,
          },
          finishedAt: Date.now(),
        });
      } catch (err) {
        jobs.set(jobId, { status: 'error', error: err.message, finishedAt: Date.now() });
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job nicht gefunden' });

  if (job.status === 'running') {
    return res.json({ status: 'running', attempts: job.attempts });
  }
  if (job.status === 'error') {
    return res.json({ status: 'error', error: job.error });
  }
  return res.json({ status: 'done', ...job.result });
});

app.post('/api/generate-sync', (req, res) => {
  try {
    const wordCount = parseInt(req.body.wordCount, 10) === 24 ? 24 : 12;
    const account = Math.max(0, parseInt(req.body.account, 10) || 0);
    const maxAttempts = Math.min(500_000, Math.max(1000, parseInt(req.body.maxAttempts, 10) || 100_000));

    const result = generateWallet({
      prefix: req.body.prefix || '',
      wordCount,
      account,
      addressPrefix: req.body.addressPrefix || '',
      maxAttempts,
    });

    res.json({
      chain: 'solana',
      mnemonic: result.mnemonic,
      address: result.address,
      secretKeyBase58: result.secretKeyBase58,
      attempts: result.attempts,
      method: result.method,
      derivationPath: result.derivationPath,
      account: result.account,
      wordCount: result.wordCount,
      prefixWords: result.prefixWords,
    });
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
});