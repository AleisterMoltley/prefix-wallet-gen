const crypto = require('crypto');
const { parentPort, workerData } = require('worker_threads');
const {
  pubkeyFromSeed,
  endsWithB58,
  startsWithB58,
} = require('../fast-grind');
const bs58mod = require('bs58');
const bs58 = bs58mod.default || bs58mod;
const { Keypair } = require('@solana/web3.js');

const {
  workerId,
  prefix,
  suffix,
  maxAttempts,
  reportEvery,
} = workerData;

const suffixBuf = suffix ? Buffer.from(suffix, 'ascii') : null;
const seed = crypto.randomBytes(32);
seed[0] ^= workerId & 0xff;
seed[1] ^= (workerId >> 8) & 0xff;

let localAttempts = 0;
let sinceReport = 0;

while (localAttempts < maxAttempts) {
  crypto.randomFillSync(seed);
  const pubkey = pubkeyFromSeed(seed);
  localAttempts++;
  sinceReport++;

  if (suffixBuf && !endsWithB58(pubkey, suffixBuf)) continue;
  if (prefix && !startsWithB58(pubkey, prefix)) {
    if (sinceReport >= reportEvery) {
      parentPort.postMessage({ type: 'progress', attemptsDelta: sinceReport });
      sinceReport = 0;
    }
    continue;
  }

  const kp = Keypair.fromSeed(seed);
  parentPort.postMessage({
    type: 'found',
    result: {
      address: bs58.encode(pubkey),
      secretKeyBase58: bs58.encode(kp.secretKey),
      seedBase58: bs58.encode(seed),
      attempts: localAttempts,
      mnemonic: null,
      derivationPath: null,
      chain: 'solana',
    },
  });
  process.exit(0);
}

if (sinceReport > 0) {
  parentPort.postMessage({ type: 'progress', attemptsDelta: sinceReport });
}
process.exit(0);