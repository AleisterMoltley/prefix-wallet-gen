//! Optimized Solana vanity grinder — based on FreeSolDev/vanity.
//! Supports --prefix and/or --suffix matching with parallel workers.

use clap::Parser;
use curve25519_dalek::{constants::ED25519_BASEPOINT_TABLE, scalar::Scalar};
use rand_chacha::ChaCha8Rng;
use rand_core::{RngCore, SeedableRng};
use rayon::prelude::*;
use sha2::{Digest, Sha512};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

const B58: &[u8; 58] =
    b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

#[derive(Parser)]
#[command(about = "Optimized Solana vanity address generator")]
struct Args {
    #[arg(long, conflicts_with = "suffix")]
    prefix: Option<String>,
    #[arg(short, long, conflicts_with = "prefix")]
    suffix: Option<String>,
    #[arg(short, long, default_value_t = default_threads())]
    threads: usize,
}

fn default_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
}

fn valid_b58(s: &[u8]) -> bool {
    !s.is_empty() && s.iter().all(|c| B58.contains(c))
}

#[inline]
fn pubkey_from_seed(seed: &[u8; 32]) -> [u8; 32] {
    let hash = Sha512::digest(seed);
    let mut a = [0u8; 32];
    a.copy_from_slice(&hash[0..32]);
    a[0] &= 248;
    a[31] &= 127;
    a[31] |= 64;
    let scalar = Scalar::from_bits(a);
    let point = &scalar * &ED25519_BASEPOINT_TABLE;
    point.compress().to_bytes()
}

#[inline]
fn ends_with_b58(pk: &[u8; 32], suffix: &[u8]) -> bool {
    let mut n = *pk;
    for &want in suffix.iter().rev() {
        let mut rem: u32 = 0;
        for b in n.iter_mut() {
            let cur = (rem << 8) | (*b as u32);
            *b = (cur / 58) as u8;
            rem = cur % 58;
        }
        if B58[rem as usize] != want {
            return false;
        }
    }
    true
}

#[inline]
fn starts_with_b58(pk: &[u8; 32], prefix: &[u8]) -> bool {
    bs58::encode(pk).into_string().as_bytes().starts_with(prefix)
}

fn main() {
    let args = Args::parse();
    let prefix = args.prefix.map(|s| s.into_bytes());
    let suffix = args.suffix.map(|s| s.into_bytes());

    if prefix.is_none() && suffix.is_none() {
        eprintln!("Error: --prefix and/or --suffix required");
        std::process::exit(2);
    }
    if let Some(ref p) = prefix {
        if !valid_b58(p) {
            eprintln!("Error: prefix must be valid base58");
            std::process::exit(2);
        }
    }
    if let Some(ref s) = suffix {
        if !valid_b58(s) {
            eprintln!("Error: suffix must be valid base58");
            std::process::exit(2);
        }
    }

    let nthreads = args.threads.max(1);
    if let Some(ref p) = prefix {
        println!("Searching for vanity prefix: \"{}\"", String::from_utf8_lossy(p));
    }
    if let Some(ref s) = suffix {
        println!("Searching for vanity suffix: \"{}\"", String::from_utf8_lossy(s));
    }
    println!("Using {} threads...", nthreads);

    let found = AtomicBool::new(false);
    let result: Mutex<Option<([u8; 32], [u8; 32])>> = Mutex::new(None);
    let start = Instant::now();

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(nthreads)
        .build()
        .expect("rayon pool");
    pool.install(|| {
        (0..nthreads).into_par_iter().for_each(|tid| {
            let mut os = [0u8; 32];
            getrandom::getrandom(&mut os).expect("os rng");
            os[0] ^= tid as u8;
            os[1] ^= (tid >> 8) as u8;
            let mut rng = ChaCha8Rng::from_seed(os);
            let mut seed = [0u8; 32];
            while !found.load(Ordering::Relaxed) {
                rng.fill_bytes(&mut seed);
                let pk = pubkey_from_seed(&seed);
                if let Some(ref s) = suffix {
                    if !ends_with_b58(&pk, s) {
                        continue;
                    }
                }
                if let Some(ref p) = prefix {
                    if !starts_with_b58(&pk, p) {
                        continue;
                    }
                }
                if !found.swap(true, Ordering::SeqCst) {
                    *result.lock().unwrap() = Some((seed, pk));
                }
                return;
            }
        });
    });

    let (seed, pk) = result.lock().unwrap().take().expect("no result found");

    {
        let sk = ed25519_dalek::SecretKey::from_bytes(&seed).expect("seed");
        let vp = ed25519_dalek::PublicKey::from(&sk);
        assert_eq!(vp.to_bytes(), pk, "derivation mismatch — refusing to emit");
    }

    let elapsed = start.elapsed().as_secs_f64();
    println!("\nFound a vanity address!");
    println!("Address: {}", bs58::encode(&pk).into_string());
    println!("Private Key (Base58): {}", bs58::encode(&seed).into_string());
    println!("Time elapsed: {:.3}", elapsed);
}