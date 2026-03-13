# Cross-VM Hello World with Wormhole Executor

Cross-chain messaging demo using Wormhole Executor for automatic relay between **Solana ↔ EVM**.

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment
cp e2e/.env.example e2e/.env
# Edit .env with your private keys

# (Fresh deployment only) Initialize program + register Sepolia peer on Solana:
npx tsx e2e/initialize.ts

# Register peers in both directions (Solana registers EVM, EVM registers Solana)
npx tsx e2e/setupPeers.ts

# Send from Solana to Sepolia
npx tsx e2e/sendToSepolia.ts "Hello from Solana!"
```

> For Sepolia → Solana, see the [EVM demo repo](https://github.com/wormhole-foundation/demo-hello-executor).

## Architecture

### Solana → EVM (two transactions required)

> ⚠️ **Important:** Sending from Solana to EVM is a **two-step** process.
> Both transactions must succeed for the message to arrive.
> Calling `send_greeting` without `request_relay` publishes to Wormhole but
> the message is never delivered.

```
Solana Devnet                              Sepolia
┌────────────────┐                    ┌────────────────┐
│ HelloExecutor  │                    │ HelloWormhole  │
│    (Anchor)    │                    │  (Solidity)    │
└───────┬────────┘                    └───────▲────────┘
        │                                     │
        │ TX 1: send_greeting()               │ executeVAAv1()
        ▼                                     │
┌────────────────┐                    ┌───────┴────────┐
│ Wormhole Core  │ ──── Guardians ──▶ │ Wormhole Core  │
│ (3u8h...)      │     sign VAA       │                │
└────────────────┘                    └────────────────┘
        │                                     ▲
        │ TX 2: request_relay()               │
        ▼                                     │
┌────────────────┐                            │
│   Executor     │ ─────── relay ─────────────┘
└────────────────┘
```

### EVM → Solana (single transaction)

```
Sepolia                                Solana Devnet
┌────────────────┐                    ┌────────────────┐
│ HelloWormhole  │                    │ HelloExecutor  │
│  (Solidity)    │                    │    (Anchor)    │
└───────┬────────┘                    └───────▲────────┘
        │                                     │
        │ sendGreetingWithMsgValue()           │ receive_greeting()
        ▼                                     │
┌────────────────┐     Executor        ┌──────┴─────────┐
│ Wormhole Core  │ ── posts VAA ──────▶│ Wormhole Core  │
└────────────────┘                    └────────────────┘
```

## Key Concepts

### 1. Cross-VM Peer Registration

For SVM ↔ EVM messaging, peer registration uses **different addresses for different purposes**:

| Side | What to register | Used for |
|------|-----------------|----------|
| **Solana** | EVM contract address (bytes32, left-padded) | Verify incoming Sepolia VAAs |
| **EVM** `setPeer` | Solana **program ID** (32 bytes, no padding) | Executor relay routing |
| **EVM** `setVaaEmitter` | Solana **emitter PDA** (32 bytes) | Verify incoming Solana VAAs |

The split on the EVM side is necessary because the Wormhole Executor uses
`peers[chainId]` as the destination address to call the resolver program
(must be executable), while incoming VAAs from Solana carry the emitter PDA
as their source (a different, non-executable account).

```typescript
// Derive both Solana addresses
const programId = new PublicKey('7eiTqf1b1dNwpzn27qEr4eGSWnuon2fJTbnTuWcFifZG');
const [emitterPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('emitter')],
    programId
);
const programIdBytes32  = '0x' + Buffer.from(programId.toBytes()).toString('hex');
const emitterPdaBytes32 = '0x' + Buffer.from(emitterPda.toBytes()).toString('hex');
```

### 2. msgValue for SVM Destinations

When sending **TO** Solana/SVM chains, include `msgValue` for rent and fees:

```typescript
const SOLANA_MSG_VALUE_LAMPORTS = 15_000_000n; // ~0.015 SOL
```

## Project Structure

```
programs/hello-executor/src/
├── lib.rs                    # Entry point & instructions
├── instructions/
│   ├── initialize.rs         # Initialize program config & Wormhole emitter
│   ├── register_peer.rs      # Register peer contract on another chain
│   ├── send_greeting.rs      # Send cross-chain message
│   ├── request_relay.rs      # Request Executor relay
│   ├── receive_greeting.rs   # Receive cross-chain message
│   └── update_config.rs      # Update Wormhole configuration (owner only)
├── state/                    # Account structures
└── resolver.rs               # Executor resolver

e2e/
├── sendToSepolia.ts          # Solana → Sepolia demo
├── setupPeers.ts             # Register peers (both directions)
├── config.ts                 # Chain configuration
├── relay.ts                  # Relay instruction encoding
└── types.ts                  # TypeScript types
```

## Environment Variables

Create `e2e/.env`:

```bash
# Solana keypair (JSON array or base58)
PRIVATE_KEY_SOLANA=[1,2,3,...] 
# Or use a file path:
# SOLANA_KEYPAIR_PATH=~/.config/solana/id.json

# Sepolia private key (for peer registration on EVM side)
PRIVATE_KEY_SEPOLIA=0x...
```

## Version Notes

The Rust program uses `anchor-lang = 0.29.0` (pinned for `wormhole-anchor-sdk` compatibility),
while the JS/TS side uses `@coral-xyz/anchor ^0.31.0`. This is intentional - the e2e scripts
use the 0.30+ `Program` constructor (`new Program(idl, provider)` with `address` in the IDL)
which is not available in 0.29. The JS SDK is backwards-compatible with 0.29-generated IDLs.

## Important Limits

### 512-byte message cap on the Solana receiver

The `Received` account - created on-chain when a message arrives on Solana - is allocated a fixed size at init time:

```
 8 bytes  discriminator
 4 bytes  batch_id
32 bytes  VAA hash
 4 bytes  message Vec length prefix
512 bytes message payload  ← GREETING_MAX_LENGTH
─────────────────────────
560 bytes total
```

Because Solana accounts cannot grow after creation, this cap is set at deployment and can only be raised via a program upgrade.

**When does it affect you?**

| Sender → Receiver | Effect |
|---|---|
| **EVM → Solana** | ⚠️ EVM enforces no limit at send time. If the payload exceeds 512 bytes, `receive_greeting` returns `InvalidMessage` and the relay transaction fails. |
| **Solana → Solana** | ✅ Rejected at send time - `HelloExecutorMessage::serialize` refuses > 512 bytes before the VAA is posted. |
| **Solana → EVM** | ✅ EVM receiver has no cap. Solana's 512-byte send limit still applies upstream, so you can never exceed it from the Solana side. |

## Resources

- [Wormhole Docs](https://wormhole.com/docs)
- [Executor Documentation](https://wormhole.com/docs/protocol/infrastructure/relayer/#executor)
- [EVM Contracts](https://github.com/wormhole-foundation/demo-hello-executor)
- [Solidity SDK](https://github.com/wormhole-foundation/wormhole-solidity-sdk)
