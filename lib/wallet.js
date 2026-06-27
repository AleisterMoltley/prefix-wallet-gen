const crypto = require('crypto');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { Keypair } = require('@solana/web3.js');
const bs58mod = require('bs58');
const bs58 = bs58mod.default || bs58mod;

const WORDLIST = bip39.wordlists.english;

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

/**
 * Generate a valid BIP-39 mnemonic whose first words match the prefix.
 * When prefix fits entirely in entropy, every attempt succeeds instantly.
 */
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
  const CS = ENT / 32;
  const prefixBits = wordsToBits(prefixWords);
  const prefixBitLen = prefixBits.length;

  if (prefixBitLen > ENT + CS) {
    throw new Error('Prefix ist zu lang für die gewählte Wortanzahl.');
  }

  if (prefixBitLen <= ENT) {
    const randomBitCount = ENT - prefixBitLen;
    const randomBytes = crypto.randomBytes(Math.ceil(randomBitCount / 8));
    let randomBits = Array.from(randomBytes)
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

const SOLANA_DERIVATION_PATH = "m/44'/501'";

function deriveSolanaKeypair(mnemonic, account = 0) {
  const clean = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!bip39.validateMnemonic(clean)) {
    throw new Error('Ungültige Mnemonic erzeugt — interner Fehler.');
  }

  const seed = bip39.mnemonicToSeedSync(clean);
  const path = `${SOLANA_DERIVATION_PATH}/${account}'/0'`;
  const { key: seed32 } = derivePath(path, seed.toString('hex'));
  const kp = Keypair.fromSeed(seed32);

  return {
    address: kp.publicKey.toBase58(),
    secretKeyBase58: bs58.encode(kp.secretKey),
    derivationPath: path,
    account,
    chain: 'solana',
  };
}

function estimateDifficulty(prefixWords, wordCount) {
  const n = prefixWords.length;
  if (n === 0) return { label: 'sofort', factor: 1 };

  const ENT = wordCount === 12 ? 128 : 256;
  const prefixBitLen = n * 11;

  if (prefixBitLen <= ENT) {
    return { label: 'sofort', factor: 1 };
  }

  const csOverlap = prefixBitLen - ENT;
  const factor = Math.pow(2, csOverlap);
  return {
    label: factor < 1000 ? 'schnell' : factor < 1_000_000 ? 'mittel' : 'sehr langsam',
    factor,
    csOverlapBits: csOverlap,
  };
}

function generateWallet(options = {}) {
  const {
    prefix = '',
    wordCount = 12,
    account = 0,
    addressPrefix = '',
    maxAttempts = 5_000_000,
    onProgress,
  } = options;

  const prefixWords = parsePrefixWords(prefix);
  validatePrefixWords(prefixWords, wordCount);

  const wantAddress = addressPrefix.trim();
  let attempts = 0;
  const reportEvery = 5000;

  while (attempts < maxAttempts) {
    attempts++;
    const { mnemonic, method } = generateMnemonicWithPrefix(prefixWords, wordCount);
    const wallet = deriveSolanaKeypair(mnemonic, account);

    if (!wantAddress || wallet.address.startsWith(wantAddress)) {
      return {
        mnemonic,
        ...wallet,
        attempts,
        method,
        wordCount,
        prefixWords,
      };
    }

    if (onProgress && attempts % reportEvery === 0) {
      onProgress({ attempts, lastAddress: wallet.address });
    }
  }

  throw new Error(
    `Keine Wallet mit Adress-Prefix "${wantAddress}" in ${maxAttempts.toLocaleString()} Versuchen gefunden.`
  );
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
};