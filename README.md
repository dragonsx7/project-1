# FixPass — Verifiable Smartphone Service History

> A QR passport for repaired and refurbished smartphones. Repair shops and resellers add signed service records; buyers can check the record history without connecting a wallet.

[Hackathon Track](https://superteam.fun/earn/listing/colosseum-crypto-worlds-fair-hackathon-superteam-kazakhstan-track) · [Demo Guide](./DEMO.md) · [Development Plan](./DEVELOPMENT_PLAN.md) · [Pilot Questions](./PILOT.md)

---

## Built for Colosseum Crypto World's Fair

FixPass is a local MVP for the **Superteam Kazakhstan Track**. It explores a practical consumer use of Solana: making service-history records independently checkable when a used phone changes hands.

## Problem and Solution

### 1. Buyers cannot see a device's service history

- **Problem:** Repair details are scattered across receipts, chats, and shop records. A buyer of a used phone may not know what was repaired or which parts were replaced.
- **FixPass:** A repair shop creates a QR passport and appends a repair record. A reseller can add an inspection to the same history. A buyer scans the QR code to review the events.

### 2. A record needs a way to detect later edits

- **Problem:** A conventional page can be silently changed by the service hosting it.
- **FixPass:** Each event is hashed with a random salt and linked to the previous event. The organization's wallet signs a Solana Devnet Memo containing the passport ID, event ID, and hash. The public passport checks the stored record against the on-chain proof.

> An on-chain proof shows that a wallet signed a particular hash and helps detect changes to that record. It does not prove that a shop's description is true, that a repair was done well, or that every event in a device's history has been disclosed.

---

## Why Solana

- **Public verification:** A buyer can check the signed hash against a public Solana transaction.
- **Low-friction records:** The MVP anchors a record with a Memo transaction instead of requiring a custom program.
- **Wallet-less buyer flow:** Only organizations connect a wallet; buyers open the QR passport in a browser.

The current prototype uses **Devnet**. It does not issue a token, NFT, or payment, and it does not custody funds.

## Features

- Wallet message sign-in for repair shops and resellers.
- Separate repair and inspection events with append-only history.
- Salted SHA-256 records linked to the preceding event.
- Solana Devnet Memo anchoring, with server-side transaction checks.
- QR passport that displays the event history and verification status without a buyer wallet.
- SQLite storage for the local pilot.

## Architecture

```text
 Repair shop / reseller
          │
          ▼
 ┌────────────────────────┐       ┌─────────────────────┐
 │ FixPass web app +      │──────▶│ Phantom wallet      │
 │ local Node.js server   │       │ signs Devnet Memo   │
 └───────────┬────────────┘       └──────────┬──────────┘
             │                               │
             ▼                               ▼
 ┌────────────────────────┐       ┌─────────────────────┐
 │ SQLite event history   │       │ Solana Devnet       │
 │ salted hash chain      │◀──────│ Memo transaction    │
 └───────────┬────────────┘       └─────────────────────┘
             │                               ▲
             └──────────────┬────────────────┘
                            ▼
                  ┌──────────────────┐
                  │ Buyer scans QR   │
                  │ and checks proof │
                  └──────────────────┘
```

Event details stay in the FixPass database. The on-chain Memo contains only a random passport ID, event ID, and salted record hash. The shop or reseller name is self-claimed by the wallet owner; business identity is not independently verified.

## Tech Stack

| Layer | Technology |
| --- | --- |
| App server | Node.js 24.15+ built-in HTTP server |
| Storage | SQLite through `node:sqlite` |
| Frontend | HTML, CSS, and JavaScript |
| Wallet | Phantom |
| Proof | Solana Memo Program on Devnet |
| Record integrity | SHA-256 with per-event random salt and previous-event hash |

## Quick Start

Prerequisite: **Node.js 24.15 or newer**. No npm packages need to be installed.

```powershell
# Start the local server
node server.mjs
```

Open the local address printed by the server (normally `http://127.0.0.1:4173`). To anchor records, install Phantom, switch it to Solana Devnet, and use test SOL. A buyer can view a passport without a wallet, but the local server must be reachable from the buyer's device.

See [DEMO.md](./DEMO.md) for the two-organization walkthrough.

## Privacy and Current Limits

- Do not enter IMEI or serial numbers, customer names, contact details, addresses, receipts, or identity documents. Real personal data is out of scope for this prototype.
- The SQLite database is stored locally and is excluded from Git. A public QR page reads event details from the server, so this MVP is not independently hosted or available when that server is offline.
- Devnet RPC providers can rate-limit or reject requests. The organization needs test SOL to publish a Memo transaction.
- A wallet signature identifies the signing wallet, not the legal identity of a repair business.
- The prototype has basic request limits and is not ready for production use or real customer records. It still needs a manual two-wallet demo, privacy review, stronger operational controls, and a hosted HTTPS pilot.

## Roadmap

- [x] Define the repair-shop → reseller → buyer flow.
- [x] Build the local MVP with wallet sign-in, SQLite history, QR passports, and Devnet Memo verification.
- [ ] Complete a manual end-to-end walkthrough using two wallets and a phone.
- [ ] Validate the workflow with a repair shop and a refurbished-phone reseller.
- [ ] Review privacy, business verification, rate limits, and hosted deployment before any real-world pilot.

See the [full development plan](./DEVELOPMENT_PLAN.md) and [pilot interview questions](./PILOT.md).

## Project Resources

- [Demo walkthrough](./DEMO.md)
- [Development plan and status](./DEVELOPMENT_PLAN.md)
- [Pilot interview guide](./PILOT.md)
- [Colosseum Crypto World's Fair — Superteam Kazakhstan Track](https://superteam.fun/earn/listing/colosseum-crypto-worlds-fair-hackathon-superteam-kazakhstan-track)
