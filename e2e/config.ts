/**
 * Configuration for EVM ↔ Solana cross-chain E2E tests
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

// ============================================================================
// Wormhole Chain IDs
// Full reference: https://wormhole.com/docs/products/reference/chain-ids/
// ============================================================================
export const CHAIN_ID_SOLANA = 1;
export const CHAIN_ID_SEPOLIA = 10002;

// ============================================================================
// Contract / Program Addresses
// ============================================================================

// Solana Devnet - HelloExecutor program
// TODO(redeploy): Update this default after deploying a new program binary.
// Run: solana-keygen pubkey target/deploy/hello_executor-keypair.json
export const HELLO_EXECUTOR_SOLANA = process.env.HELLO_EXECUTOR_SOLANA ||
    '7eiTqf1b1dNwpzn27qEr4eGSWnuon2fJTbnTuWcFifZG';

// Sepolia - HelloWormhole contract (with cross-VM support)
// TODO(redeploy): Update this default if deploying a new EVM contract.
export const HELLO_WORMHOLE_SEPOLIA = process.env.HELLO_WORMHOLE_SEPOLIA ||
    '0x15cEeB2C089D19E754463e1697d69Ad11A6e8841';

// Wormhole infrastructure
export const WORMHOLE_CORE_BRIDGE_SOLANA = '3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5';
export const EXECUTOR_PROGRAM_SOLANA = 'execXUrAsMnqMmTHj5m7N1YQgsDz3cwGLYCYyuDRciV';

// On-chain quoter infrastructure (devnet only).
// Solana on-chain quotes are currently supported only on devnet.
export const EXECUTOR_QUOTER_ROUTER_PROGRAM = new PublicKey('qtrrrV7W3E1jnX1145wXR6ZpthG19ur5xHC1n6PPhDV');
export const EXECUTOR_QUOTER_PROGRAM = new PublicKey('qtrxiqVAfVS61utwZLUi7UKugjCgFaNxBGyskmGingz');
export const QUOTER_EVM_ADDRESS = '5241C9276698439fEf2780DbaB76fEc90B633Fbd';

// ============================================================================
// RPC URLs
// ============================================================================
export const SOLANA_RPC = process.env.SOLANA_DEVNET_RPC || 'https://api.devnet.solana.com';
export const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';

// ============================================================================
// Executor API
// ============================================================================
export const EXECUTOR_API = 'https://executor-testnet.labsapis.com/v0';

// Solana-specific: msgValue in LAMPORTS for rent, priority fees
// ~0.015 SOL covers typical Solana transaction costs
export const SOLANA_MSG_VALUE_LAMPORTS = 15_000_000n;

// ============================================================================
// Keypair Loading
// ============================================================================

export function loadSolanaKeypair(envVar = 'PRIVATE_KEY_SOLANA'): Keypair {
    // Try environment variable first
    const envKey = process.env[envVar];
    if (envKey) {
        try {
            const parsed = JSON.parse(envKey);
            if (Array.isArray(parsed)) {
                return Keypair.fromSecretKey(Uint8Array.from(parsed));
            }
        } catch {
            // Base58-encoded private key.
            // Use dynamic import to avoid CJS require() in ESM context.
            throw new Error(
                `PRIVATE_KEY_SOLANA looks like a base58 string, but base58 decoding ` +
                    `via require('bs58') is not supported in ESM.\n` +
                    `Please convert to JSON array format:\n` +
                    `  solana-keygen show --keypair <path> | head -1\n` +
                    `Or set SOLANA_KEYPAIR_PATH to your keypair file instead.`
            );
        }
    }

    // Try common keypair paths
    const paths = [
        process.env.SOLANA_KEYPAIR_PATH,
        path.join(process.env.HOME || '', '.config/solana/test-wallets/solana-devnet.json'),
        path.join(process.env.HOME || '', '.config/solana/id.json'),
    ].filter(Boolean) as string[];

    for (const p of paths) {
        if (fs.existsSync(p)) {
            const keyData = JSON.parse(fs.readFileSync(p, 'utf-8'));
            return Keypair.fromSecretKey(Uint8Array.from(keyData));
        }
    }

    throw new Error(`No Solana keypair found. Set ${envVar} or provide a keypair file.`);
}

export function loadEvmWallet(): ethers.Wallet {
    const privateKey = process.env.PRIVATE_KEY_SEPOLIA;
    if (!privateKey) {
        throw new Error('PRIVATE_KEY_SEPOLIA not set');
    }
    const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
    return new ethers.Wallet(privateKey, provider);
}

// ============================================================================
// Address Conversion Utilities
// ============================================================================

/**
 * Convert EVM address (20 bytes) to bytes32 (left-padded with zeros)
 */
export function evmAddressToBytes32(address: string): Uint8Array {
    const cleaned = address.toLowerCase().replace(/^0x/, '');
    const padded = cleaned.padStart(64, '0');
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/**
 * Convert Solana PublicKey to bytes32 (native format, no padding needed)
 */
export function solanaAddressToBytes32(pubkey: PublicKey): Uint8Array {
    return pubkey.toBytes();
}

/**
 * Derive the emitter PDA for a Solana program.
 * On the EVM side, register two separate addresses:
 *   setPeer(programId)        — executor routing (must be executable)
 *   setVaaEmitter(emitterPDA) — VAA verification (what Wormhole stamps as source)
 */
export function deriveEmitterPda(programId: PublicKey): PublicKey {
    const [emitterPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('emitter')],
        programId
    );
    return emitterPda;
}

// ============================================================================
// Config Object
// ============================================================================

export const config = {
    solana: {
        rpcUrl: SOLANA_RPC,
        programId: new PublicKey(HELLO_EXECUTOR_SOLANA),
        wormholeChainId: CHAIN_ID_SOLANA,
        wormholeCoreBridge: new PublicKey(WORMHOLE_CORE_BRIDGE_SOLANA),
        executorProgram: new PublicKey(EXECUTOR_PROGRAM_SOLANA),
    },
    sepolia: {
        rpcUrl: SEPOLIA_RPC,
        contractAddress: HELLO_WORMHOLE_SEPOLIA,
        wormholeChainId: CHAIN_ID_SEPOLIA,
    },
    executor: {
        apiUrl: EXECUTOR_API,
        solanaMsgValue: SOLANA_MSG_VALUE_LAMPORTS,
    },
};
