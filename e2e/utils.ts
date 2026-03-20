import {
    Connection,
    PublicKey,
    SystemProgram,
    SYSVAR_CLOCK_PUBKEY,
    SYSVAR_RENT_PUBKEY,
    TransactionInstruction,
} from '@solana/web3.js';
import { createHash } from 'crypto';

import { CHAIN_ID_SOLANA, EXECUTOR_API } from './config.js';

// ============================================================================
// PDA Derivations
// ============================================================================

/**
 * Generic PDA derivation. Seeds can be strings (converted to Buffer) or Buffers.
 */
export function derivePda(programId: PublicKey, ...seeds: (string | Buffer | Uint8Array)[]): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s),
        programId
    );
    return pda;
}

/** Encode a u16 as a 2-byte little-endian Buffer. */
export function u16le(value: number): Buffer {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(value);
    return buf;
}

/** Encode a u64 as an 8-byte little-endian Buffer. */
export function u64le(value: bigint): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(value);
    return buf;
}

// ============================================================================
// Helpers
// ============================================================================

export function getDiscriminator(name: string): Buffer {
    const hash = createHash('sha256');
    hash.update(`global:${name}`);
    return Buffer.from(hash.digest().slice(0, 8));
}

// ============================================================================
// Instructions
// ============================================================================

/**
 * Build the send_greeting instruction for the hello-executor program.
 *
 * This is the first step in both the off-chain and on-chain quote flows:
 * it posts a Wormhole message containing the greeting to the Core Bridge.
 */
export function buildSendGreetingInstruction(params: {
    payer: PublicKey;
    programId: PublicKey;
    configPda: PublicKey;
    wormholeProgram: PublicKey;
    wormholeBridge: PublicKey;
    wormholeFeeCollector: PublicKey;
    emitterPda: PublicKey;
    wormholeSequence: PublicKey;
    wormholeMessage: PublicKey;
    greeting: string;
}): TransactionInstruction {
    const discriminator = getDiscriminator('send_greeting');
    const greetingBytes = Buffer.from(params.greeting, 'utf-8');
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32LE(greetingBytes.length);
    const data = Buffer.concat([discriminator, lengthBuffer, greetingBytes]);

    return new TransactionInstruction({
        keys: [
            { pubkey: params.payer, isSigner: true, isWritable: true },
            { pubkey: params.configPda, isSigner: false, isWritable: false },
            { pubkey: params.wormholeProgram, isSigner: false, isWritable: false },
            { pubkey: params.wormholeBridge, isSigner: false, isWritable: true },
            { pubkey: params.wormholeFeeCollector, isSigner: false, isWritable: true },
            { pubkey: params.emitterPda, isSigner: false, isWritable: true },
            { pubkey: params.wormholeSequence, isSigner: false, isWritable: true },
            { pubkey: params.wormholeMessage, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ],
        programId: params.programId,
        data,
    });
}

// ============================================================================
// Polling
// ============================================================================

const POLL_ATTEMPTS = 36;
const POLL_INTERVAL_MS = 5000;

type PollCallback<T> = () => Promise<T | null>;

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollWithRetry<T>(label: string, callback: PollCallback<T>): Promise<T | null> {
    console.log(`\n${label}`);

    for (let i = 0; i < POLL_ATTEMPTS; i++) {
        try {
            const result = await callback();
            if (result !== null) {
                return result;
            }
        } catch {}

        await sleep(POLL_INTERVAL_MS);
        process.stdout.write('.');
    }

    return null;
}

/**
 * Get the current Wormhole sequence tracker value.
 *
 * The tracker stores the sequence Wormhole will assign to the NEXT post_message
 * call. If the tracker account does not exist yet, return 1n to match the
 * deployed program's init-time convention.
 */
export async function getCurrentSequence(
    connection: Connection,
    sequencePda: PublicKey
): Promise<bigint> {
    const accountInfo = await connection.getAccountInfo(sequencePda);
    if (!accountInfo) {
        return 1n;
    }

    return BigInt(accountInfo.data.readBigUInt64LE(0));
}

export async function pollForVAA(
    emitterChain: number,
    emitterAddress: string,
    sequence: number
): Promise<any> {
    const baseUrl = 'https://api.testnet.wormholescan.io/api/v1/vaas';
    const paddedEmitter = emitterAddress.padStart(64, '0');
    const url = `${baseUrl}/${emitterChain}/${paddedEmitter}/${sequence}`;

    return pollWithRetry(`Polling for VAA (chain=${emitterChain}, seq=${sequence})...`, async () => {
        const response = await fetch(url);
        if (!response.ok) {
            return null;
        }

        const data: any = await response.json();
        return data.data?.vaa ? data.data : null;
    });
}

/**
 * Poll the Executor API for relay status on a Solana-source transaction.
 *
 * Terminal statuses:
 * - submitted: relay transaction reached the destination chain
 * - error: relay failed
 * - underpaid: relay payment was insufficient
 */
export async function pollExecutorStatus(txHash: string): Promise<any> {
    return pollWithRetry('Polling executor status...', async () => {
        const response = await fetch(`${EXECUTOR_API}/status/tx`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chainId: CHAIN_ID_SOLANA, txHash }),
        });
        if (!response.ok) {
            return null;
        }

        const data: any = await response.json();
        if (!Array.isArray(data) || data.length === 0) {
            return null;
        }

        const item = data[0];
        const status = item.status;
        if (status === 'submitted' && item.txs?.length > 0) {
            return item;
        }
        if (status === 'error' || status === 'underpaid') {
            return item;
        }

        return null;
    });
}
