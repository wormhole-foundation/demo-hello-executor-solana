/**
 * Type definitions for cross-chain E2E tests
 */

import { Keypair, PublicKey } from '@solana/web3.js';

export interface ChainConfig {
    chain: string;
    network: 'Testnet' | 'Mainnet';
    rpcUrl: string;
    keypair: Keypair;
    programId: PublicKey;
    wormholeChainId: number;
}

export interface ExecutorQuote {
    signedQuote: string;
    estimatedCost: string;
    parsedQuote?: {
        baseFee: bigint;
        dstGasPrice: bigint;
        srcPrice: bigint;
        dstPrice: bigint;
    };
}

export interface ExecutorStatus {
    // Executor API status values:
    //   'pending'    — waiting for VAA / being processed
    //   'submitted'  — relay TX included on destination chain (SUCCESS state)
    //                  txs[] is populated with destination TX hashes
    //   'error'      — relay failed (execution reverted, etc.)
    //   'underpaid'  — insufficient payment to Executor
    // Note: 'completed' is NOT a real status — use 'submitted' + txs.length > 0
    status: 'pending' | 'submitted' | 'error' | 'underpaid';
    failureCause?: string;
    txs?: Array<{ txHash: string; chainId?: number; blockNumber?: string }>;
}
