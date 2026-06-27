const crypto = require('crypto');
const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { Keypair } = require('@solana/web3.js');
const bs58mod = require('bs58');
const bs58 = bs58mod.default || bs58mod;
const { validateBase58Pattern } = require('./fast-grind');
const { grindAddressParallel, defaultThreads } = require('./grind-pool');
const { isGrinderAvailable, grindWithRust } = require('./rust-grinder');

const WORDLIST = bip39.wordlists.english;
const SOLANA_DERIVATION_PATH = "m/44'/501'";
const MNEMONIC_WORKER = path.join(__dirname, 'workers', 'mnemonic-grind-worker.js');

function parsePrefixWords(input) {
  if (!input || !input.trim()) return [];
  return input
    .trim()
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
}

function validatePrefixWords(words, wordCount) {
  if (words.length >= wordCount) {
    throw new Error(`Prefix hat ${words.length} Wörter — maximal ${wordCount - 1} erlaubt.`);
  }
  for (const w of words) {
    if (!WORDLIST.includes(w)) {
      throw new Error(`"${w}" ist kein gültiges BIP-39 Wort.`);
    }
  }
}

function wordsToBits(words) {
  return words
    .map((w) => {
      const idx = WORDLIST.indexOf(w);
      return idx.toString(2).padStart(11, '0');
    })
    .join('');
}

function entropyFromBits(bits) {
  const bytes = bits.length / 8;
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) {
    buf[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return buf;
}

function checksumBits(entropy) {
  const hash = crypto.createHash('sha256').update(entropy).digest();
  const csLen = entropy.length * 8 / 32;
  const hashBits = Array.from(hash)
    .map((b) => b.toString(2).padStart(8, '0'))
    .join('');
  return hashBits.slice(0, csLen);
}

function generateMnemonicWithPrefix(prefixWords, wordCount = 12) {
  validatePrefixWords(prefixWords, wordCount);

  if (prefixWords.length === 0) {
    const strength = wordCount === 24 ? 256 : 128;
    return {
      mnemonic: bip39.generateMnemonic(strength),
      attempts: 1,
      method: 'random',
    };
  }

  const ENT = wordCount === 12 ? 128 : 256;
  const prefixBits = wordsToBits(prefixWords);
  const prefixBitLen = prefixBits.length;

  if (prefixBitLen > ENT + ENT / 32) {
    throw new Error('Prefix ist zu lang für die gewählte Wortanzahl.');
  }

  if (prefixBitLen <= ENT) {
    const randomBitCount = ENT - prefixBitLen;
    const randomBytes = crypto.randomBytes(Math.ceil(randomBitCount / 8));
    const randomBits = Array.from(randomBytes)
      .map((b) => b.toString(2).padStart(8, '0'))
      .join('')
      .slice(0, randomBitCount);

    const entropyBits = prefixBits + randomBits;
    const entropy = entropyFromBits(entropyBits);
    const mnemonic = bip39.entropyToMnemonic(entropy.toString('hex'));
    return { mnemonic, attempts: 1, method: 'prefix-entropy' };
  }

  const entropyBits = prefixBits.slice(0, ENT);
  const requiredCsBits = prefixBits.slice(ENT, prefixBitLen);
  const entropy = entropyFromBits(entropyBits);
  const actualCsBits = checksumBits(entropy);

  if (actualCsBits.slice(0, requiredCsBits.length) !== requiredCsBits) {
    throw new Error(
      'Dieser Prefix ist mathematisch unmöglich (Checksum passt nicht). Versuche weniger Prefix-Wörter.'
    );
  }

  const mnemonic = bip39.entropyToMnemonic(entropy.toString('hex'));
  return { mnemonic, attempts: 1, method: 'prefix-checksum' };
}

function deriveSolanaKeypair(mnemonic, account = 0) {
  const clean = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!bip39.validateMnemonic(clean)) {
    throw new Error('Ungültige Mnemonic erzeugt — interner Fehler.');
  }

  const seed = bip39.mnemonicToSeedSync(clean);
  const derivationPath = `${SOLANA_DERIVATION_PATH}/${account}'/0'`;
  const { key: seed32 } = derivePath(derivationPath, seed.toString('hex'));
  const kp = Keypair.fromSeed(seed32);

  return {
    address: kp.publicKey.toBase58(),
    secretKeyBase58: bs58.encode(kp.secretKey),
    derivationPath,
    account,
    chain: 'solana',
  };
}

function estimateDifficulty(prefixWords, wordCount, { addressPrefix = '', addressSuffix = '' } = {}) {
  const mnemonic = { label: 'sofort', factor: 1 };
  const n = prefixWords.length;

  if (n > 0) {
    const ENT = wordCount === 12 ? 128 : 256;
    const prefixBitLen = n * 11;
    if (prefixBitLen > ENT) {
      const csOverlap = prefixBitLen - ENT;
      const factor = Math.pow(2, csOverlap);
      mnemonic.label = factor < 1000 ? 'schnell' : factor < 1_000_000 ? 'mittel' : 'sehr langsam';
      mnemonic.factor = factor;
    }
  }

  const addr = addressPrefix.trim();
  const suf = addressSuffix.trim();
  let address = null;
  if (addr || suf) {
    const chars = (addr.length || 0) + (suf.length || 0);
    const factor = Math.pow(58, Math.max(addr.length, suf.length));
    address = {
      label: chars <= 2 ? 'schnell' : chars === 3 ? 'mittel' : chars === 4 ? 'langsam' : 'sehr langsam',
      factor,
      engine: isGrinderAvailable() ? 'rust-grinder' : `node-workers×${defaultThreads()}`,
    };
  }

  return { mnemonic, address };
}

async function grindVanityAddress({ addressPrefix, addressSuffix, maxAttempts, onProgress, timeoutMs }) {
  const prefix = addressPrefix.trim();
  const suffix = addressSuffix.trim();
  const err = validateBase58Pattern(prefix, 'Adress-Prefix') ||
    validateBase58Pattern(suffix, 'Adress-Suffix');
  if (err) throw new Error(err);

  if (isGrinderAvailable()) {
    return grindWithRust({
      prefix,
      suffix,
      timeoutMs: timeoutMs || 300_000,
      threads: defaultThreads(),
    });
  }

  return grindAddressParallel({
    prefix,
    suffix,
    maxAttempts,
    threads: defaultThreads(),
    onProgress,
  });
}

function grindMnemonicWithAddressFilter(options) {
  const {
    prefixWords,
    wordCount,
    account,
    addressPrefix,
    addressSuffix,
    maxAttempts,
    onProgress,
    threads = defaultThreads(),
  } = options;

  const wantPrefix = addressPrefix.trim();
  const wantSuffix = addressSuffix.trim();
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
      const worker = new Worker(MNEMONIC_WORKER, {
        workerData: {
          workerId: id,
          prefixWords,
          wordCount,
          account,
          addressPrefix: wantPrefix,
          addressSuffix: wantSuffix,
          maxAttempts: perThread,
          reportEvery: 100,
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
            engine: `mnemonic-workers×${threadCount}`,
          };
          finish(null, winner);
        }
      });

      worker.on('error', (err) => finish(err));
      worker.on('exit', (code) => {
        pending--;
        if (!stopped && pending === 0 && !winner) {
          finish(new Error('Keine passende Wallet gefunden.'));
        }
      });

      return worker;
    });
  });
}

async function generateWallet(options = {}) {
  const {
    prefix = '',
    wordCount = 12,
    account = 0,
    addressPrefix = '',
    addressSuffix = '',
    maxAttempts = 5_000_000,
    onProgress,
    timeoutMs,
  } = options;

  const prefixWords = parsePrefixWords(prefix);
  validatePrefixWords(prefixWords, wordCount);

  const wantAddrPrefix = addressPrefix.trim();
  const wantAddrSuffix = addressSuffix.trim();
  const hasMnemonicPrefix = prefixWords.length > 0;
  const hasAddressFilter = Boolean(wantAddrPrefix || wantAddrSuffix);

  if (!hasMnemonicPrefix && hasAddressFilter) {
    const vanity = await grindVanityAddress({
      addressPrefix: wantAddrPrefix,
      addressSuffix: wantAddrSuffix,
      maxAttempts,
      onProgress,
      timeoutMs,
    });
    return {
      ...vanity,
      wordCount,
      prefixWords: [],
      method: 'vanity-fast',
      account: null,
      note: 'Vanity-Wallet ohne Mnemonic — Private Key direkt importieren (Phantom: Einstellungen → Wallet hinzufügen → Private Key).',
    };
  }

  if (hasMnemonicPrefix && !hasAddressFilter) {
    const { mnemonic, method, attempts } = generateMnemonicWithPrefix(prefixWords, wordCount);
    const wallet = deriveSolanaKeypair(mnemonic, account);
    return {
      mnemonic,
      ...wallet,
      attempts,
      method,
      wordCount,
      prefixWords,
      engine: 'mnemonic-instant',
    };
  }

  if (hasMnemonicPrefix && hasAddressFilter) {
    const result = await grindMnemonicWithAddressFilter({
      prefixWords,
      wordCount,
      account,
      addressPrefix: wantAddrPrefix,
      addressSuffix: wantAddrSuffix,
      maxAttempts,
      onProgress,
    });
    return result;
  }

  const { mnemonic, method } = generateMnemonicWithPrefix([], wordCount);
  const wallet = deriveSolanaKeypair(mnemonic, account);
  return {
    mnemonic,
    ...wallet,
    attempts: 1,
    method,
    wordCount,
    prefixWords: [],
    engine: 'random',
  };
}

module.exports = {
  WORDLIST,
  SOLANA_DERIVATION_PATH,
  parsePrefixWords,
  validatePrefixWords,
  generateMnemonicWithPrefix,
  deriveSolanaKeypair,
  estimateDifficulty,
  generateWallet,
  isGrinderAvailable,
  defaultThreads,
};