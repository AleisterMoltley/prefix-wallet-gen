const crypto = require('crypto');
const { parentPort, workerData } = require('worker_threads');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { Keypair } = require('@solana/web3.js');
const bs58mod = require('bs58');
const bs58 = bs58mod.default || bs58mod;
const { endsWithB58, startsWithB58 } = require('../fast-grind');

const WORDLIST = bip39.wordlists.english;
const SOLANA_DERIVATION_PATH = "m/44'/501'";

function wordsToBits(words) {
  return words.map((w) => WORDLIST.indexOf(w).toString(2).padStart(11, '0')).join('');
}

function entropyFromBits(bits) {
  const bytes = bits.length / 8;
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) {
    buf[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return buf;
}

function mnemonicWithPrefix(prefixWords, wordCount) {
  const ENT = wordCount === 12 ? 128 : 256;
  const prefixBits = wordsToBits(prefixWords);
  const randomBitCount = ENT - prefixBits.length;
  const randomBytes = crypto.randomBytes(Math.ceil(randomBitCount / 8));
  const randomBits = Array.from(randomBytes)
    .map((b) => b.toString(2).padStart(8, '0'))
    .join('')
    .slice(0, randomBitCount);
  const entropy = entropyFromBits(prefixBits + randomBits);
  return bip39.entropyToMnemonic(entropy.toString('hex'));
}

const {
  workerId,
  prefixWords,
  wordCount,
  account,
  addressPrefix,
  addressSuffix,
  maxAttempts,
  reportEvery,
} = workerData;

const suffixBuf = addressSuffix ? Buffer.from(addressSuffix, 'ascii') : null;
const derivationPath = `${SOLANA_DERIVATION_PATH}/${account}'/0'`;
let localAttempts = 0;
let sinceReport = 0;

while (localAttempts < maxAttempts) {
  const mnemonic = mnemonicWithPrefix(prefixWords, wordCount);
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const { key: seed32 } = derivePath(derivationPath, seed.toString('hex'));
  const kp = Keypair.fromSeed(seed32);
  const pubkey = kp.publicKey.toBytes();
  localAttempts++;
  sinceReport++;

  if (suffixBuf && !endsWithB58(pubkey, suffixBuf)) {
    if (sinceReport >= reportEvery) {
      parentPort.postMessage({ type: 'progress', attemptsDelta: sinceReport });
      sinceReport = 0;
    }
    continue;
  }
  if (addressPrefix && !startsWithB58(pubkey, addressPrefix)) {
    if (sinceReport >= reportEvery) {
      parentPort.postMessage({ type: 'progress', attemptsDelta: sinceReport });
      sinceReport = 0;
    }
    continue;
  }

  parentPort.postMessage({
    type: 'found',
    result: {
      mnemonic,
      address: kp.publicKey.toBase58(),
      secretKeyBase58: bs58.encode(kp.secretKey),
      derivationPath,
      account,
      chain: 'solana',
      method: 'mnemonic-vanity',
      wordCount,
      prefixWords,
      attempts: localAttempts,
    },
  });
  process.exit(0);
}

if (sinceReport > 0) {
  parentPort.postMessage({ type: 'progress', attemptsDelta: sinceReport });
}
process.exit(0);