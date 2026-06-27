const crypto = require('crypto');
const ed25519 = require('@noble/ed25519');
const { sha512 } = require('@noble/hashes/sha512');
const bs58mod = require('bs58');
const bs58 = bs58mod.default || bs58mod;

ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_BYTES = Buffer.from(B58, 'ascii');

function validateBase58Pattern(value, label) {
  if (!value) return null;
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) {
    return `${label} enthält ungültige Base58-Zeichen (0, O, I, l nicht erlaubt).`;
  }
  return null;
}

function pubkeyFromSeed(seed32) {
  return ed25519.getPublicKey(seed32);
}

function endsWithB58(pubkey, suffix) {
  const bytes = suffix instanceof Buffer ? suffix : Buffer.from(suffix, 'ascii');
  const n = Buffer.from(pubkey);
  for (let i = bytes.length - 1; i >= 0; i--) {
    let rem = 0;
    for (let j = 0; j < n.length; j++) {
      const cur = (rem << 8) + n[j];
      n[j] = Math.floor(cur / 58);
      rem = cur % 58;
    }
    if (B58_BYTES[rem] !== bytes[i]) return false;
  }
  return true;
}

function startsWithB58(pubkey, prefix) {
  return bs58.encode(pubkey).startsWith(prefix);
}

function matchesAddressPattern(pubkey, { prefix, suffix }) {
  if (suffix && !endsWithB58(pubkey, suffix)) return false;
  if (prefix && !startsWithB58(pubkey, prefix)) return false;
  return true;
}

function grindAddressSync({
  prefix = '',
  suffix = '',
  maxAttempts = 50_000_000,
  onProgress,
  reportEvery = 10_000,
}) {
  const wantPrefix = prefix.trim();
  const wantSuffix = suffix.trim();
  if (!wantPrefix && !wantSuffix) {
    throw new Error('Prefix oder Suffix für Vanity-Suche erforderlich.');
  }

  const err = validateBase58Pattern(wantPrefix, 'Adress-Prefix') ||
    validateBase58Pattern(wantSuffix, 'Adress-Suffix');
  if (err) throw new Error(err);

  const suffixBuf = wantSuffix ? Buffer.from(wantSuffix, 'ascii') : null;
  const seed = crypto.randomBytes(32);
  let attempts = 0;
  const start = Date.now();

  while (attempts < maxAttempts) {
    crypto.randomFillSync(seed);
    const pubkey = pubkeyFromSeed(seed);

    if (suffixBuf && !endsWithB58(pubkey, suffixBuf)) {
      attempts++;
      continue;
    }
    if (wantPrefix && !startsWithB58(pubkey, wantPrefix)) {
      attempts++;
      if (onProgress && attempts % reportEvery === 0) {
        onProgress({ attempts, keysPerSec: Math.round(attempts / ((Date.now() - start) / 1000)) });
      }
      continue;
    }

    attempts++;
    const address = bs58.encode(pubkey);
    const { Keypair } = require('@solana/web3.js');
    const kp = Keypair.fromSeed(seed);

    return {
      address,
      secretKeyBase58: bs58.encode(kp.secretKey),
      seedBase58: bs58.encode(seed),
      attempts,
      elapsedMs: Date.now() - start,
      engine: 'node-fast',
      mnemonic: null,
      derivationPath: null,
      chain: 'solana',
    };
  }

  throw new Error(`Keine Vanity-Adresse in ${maxAttempts.toLocaleString()} Versuchen gefunden.`);
}

module.exports = {
  B58,
  validateBase58Pattern,
  pubkeyFromSeed,
  endsWithB58,
  startsWithB58,
  matchesAddressPattern,
  grindAddressSync,
};