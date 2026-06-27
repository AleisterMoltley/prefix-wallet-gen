const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Keypair } = require('@solana/web3.js');
const bs58mod = require('bs58');
const bs58 = bs58mod.default || bs58mod;

const CANDIDATE_PATHS = [
  process.env.SOLANA_VANITY_BIN,
  '/usr/local/bin/solana-vanity',
  path.join(__dirname, '..', 'bin', 'solana-vanity'),
].filter(Boolean);

let cachedBin = undefined;

function findGrinderBinary() {
  if (cachedBin !== undefined) return cachedBin;
  cachedBin = CANDIDATE_PATHS.find((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }) || null;
  return cachedBin;
}

function isGrinderAvailable() {
  return Boolean(findGrinderBinary());
}

function grindWithRust({ prefix = '', suffix = '', timeoutMs = 300_000, threads }) {
  const bin = findGrinderBinary();
  if (!bin) {
    return Promise.reject(new Error('Rust-Grinder nicht verfügbar'));
  }

  const wantPrefix = prefix.trim();
  const wantSuffix = suffix.trim();
  if (!wantPrefix && !wantSuffix) {
    return Promise.reject(new Error('Prefix oder Suffix erforderlich'));
  }

  const args = [];
  if (wantPrefix) args.push('--prefix', wantPrefix);
  if (wantSuffix) args.push('--suffix', wantSuffix);
  if (threads) args.push('--threads', String(threads));

  return new Promise((resolve, reject) => {
    const start = Date.now();
    let killed = false;
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timeout = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      reject(new Error(`Rust-Grinder Timeout nach ${timeoutMs}ms`));
    }, timeoutMs);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (killed) return;

      const output = stdout + stderr;
      if (code !== 0) {
        reject(new Error(`Rust-Grinder fehlgeschlagen: ${output.trim()}`));
        return;
      }

      try {
        const addressMatch = output.match(/Address:\s*([1-9A-HJ-NP-Za-km-z]{32,50})/);
        const seedMatch = output.match(/Private Key \(Base58\):\s*([1-9A-HJ-NP-Za-km-z]{32,90})/);
        const timeMatch = output.match(/Time elapsed:\s*([\d.]+)/);
        if (!addressMatch || !seedMatch) {
          reject(new Error('Rust-Grinder Output nicht parsebar'));
          return;
        }

        const address = addressMatch[1];
        const seedBytes = bs58.decode(seedMatch[1]);
        const kp = Keypair.fromSeed(Buffer.from(seedBytes).slice(0, 32));

        if (kp.publicKey.toBase58() !== address) {
          reject(new Error('Rust-Grinder: Adress-Verifikation fehlgeschlagen'));
          return;
        }

        resolve({
          address,
          secretKeyBase58: bs58.encode(kp.secretKey),
          seedBase58: seedMatch[1],
          attempts: null,
          elapsedMs: Date.now() - start,
          grinderTimeSeconds: timeMatch ? parseFloat(timeMatch[1]) : null,
          engine: 'rust-grinder',
          mnemonic: null,
          derivationPath: null,
          chain: 'solana',
        });
      } catch (err) {
        reject(err);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

module.exports = {
  findGrinderBinary,
  isGrinderAvailable,
  grindWithRust,
};