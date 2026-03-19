import { Connection, PublicKey } from '@solana/web3.js';

import { CHAIN_ID_SOLANA, EXECUTOR_API } from './config.js';

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
