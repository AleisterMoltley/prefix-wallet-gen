# Solana Prefix Wallet Gen

**Nur Solana** — Wallet-Generator mit BIP-39 Prefix-Wörtern. Die Seed Phrase beginnt mit deinen gewünschten Wörtern.

## Features

- Prefix-Wörter am Anfang der Mnemonic (12 oder 24 Wörter)
- Standard Solana HD-Derivation (`m/44'/501'/0'/0'`) — Phantom, Solflare, Backpack
- Optionales Vanity-Adress-Prefix für Solana-Adressen
- Einfaches Web-Dashboard

## Lokal starten

```bash
npm install
npm start
```

Öffne http://localhost:3000

## Live Demo

https://prefix-wallet-gen-production.up.railway.app

## Railway Deploy

1. Repo mit GitHub verbinden
2. Railway erkennt `railway.json` automatisch
3. Healthcheck: `/health`

## Sicherheit

**Wichtig:** Auf einem Server generierte Seeds können geloggt werden. Für echte Gelder das Repo klonen und **offline/lokal** nutzen.

## Lizenz

MIT