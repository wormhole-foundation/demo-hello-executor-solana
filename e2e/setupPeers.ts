#!/usr/bin/env tsx
/**
 * Unified Peer Registration for EVM ↔ Solana
 * 
 * This script registers peers in both directions:
 * 1. Solana → registers EVM contract address as peer
 * 2. EVM → two-step: setPeer(programId) for routing + setVaaEmitter(emitterPDA) for VAA verification
 * 
 * Usage:
 *   npx tsx e2e/setupPeers.ts          # Both directions
 *   npx tsx e2e/setupPeers.ts solana   # Solana side only
 *   npx tsx e2e/setupPeers.ts evm      # EVM side only
 */

import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet, Idl } from '@coral-xyz/anchor';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
    config,
    loadSolanaKeypair,
    loadEvmWallet,
    evmAddressToBytes32,
    deriveEmitterPda,
    CHAIN_ID_SEPOLIA,
    CHAIN_ID_SOLANA,
    HELLO_WORMHOLE_SEPOLIA,
    HELLO_EXECUTOR_SOLANA,
} from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Solana Side - Register EVM peer
// ============================================================================

function loadIdl(): Idl {
    // Try paths in order of preference
    const candidates = [
        path.join(__dirname, 'abi', 'hello_executor.json'),   // e2e/abi/ (committed)
        path.join(__dirname, '..', 'idls', 'hello_executor.json'), // idls/ (root)
        path.join(__dirname, '..', 'target', 'idl', 'hello_executor.json'), // anchor build output
    ];

    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return JSON.parse(fs.readFileSync(p, 'utf-8'));
        }
    }

    throw new Error(
        `IDL not found. Checked:\n${candidates.map(p => `  - ${p}`).join('\n')}\nRun 'anchor build' to generate it.`
    );
}

function derivePeerPda(programId: PublicKey, chainId: number): PublicKey {
    const chainIdBuffer = Buffer.alloc(2);
    chainIdBuffer.writeUInt16LE(chainId);
    const [peerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('peer'), chainIdBuffer],
        programId
    );
    return peerPda;
}

function deriveConfigPda(programId: PublicKey): PublicKey {
    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('config')],
        programId
    );
    return configPda;
}

async function registerEvmPeerOnSolana(): Promise<boolean> {
    console.log('\n📋 SOLANA: Registering EVM peer...\n');

    const keypair = loadSolanaKeypair();
    console.log(`  Wallet: ${keypair.publicKey.toBase58()}`);

    const connection = new Connection(config.solana.rpcUrl, 'confirmed');
    const balance = await connection.getBalance(keypair.publicKey);
    console.log(`  Balance: ${balance / 1e9} SOL`);

    const programId = config.solana.programId;
    const wallet = new Wallet(keypair);
    const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    
    const idl = loadIdl();
    const idlWithAddress = { ...idl, address: programId.toBase58() };
    const program = new Program(idlWithAddress as Idl, provider);

    const configPda = deriveConfigPda(programId);
    const peerPda = derivePeerPda(programId, CHAIN_ID_SEPOLIA);

    // Convert EVM address to bytes array for Anchor
    const peerAddressBytes = Array.from(evmAddressToBytes32(HELLO_WORMHOLE_SEPOLIA));

    console.log(`\n  Registering:`);
    console.log(`    Chain ID: ${CHAIN_ID_SEPOLIA} (Sepolia)`);
    console.log(`    EVM Contract: ${HELLO_WORMHOLE_SEPOLIA}`);
    console.log(`    Peer PDA: ${peerPda.toBase58()}`);

    try {
        const tx = await program.methods
            .registerPeer(CHAIN_ID_SEPOLIA, peerAddressBytes)
            .accounts({
                owner: keypair.publicKey,
                config: configPda,
                peer: peerPda,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        console.log(`\n  ✅ Success! TX: ${tx}`);
        console.log(`  Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`);
        return true;
    } catch (error: any) {
        if (error.message?.includes('already in use')) {
            console.log('\n  ⚠️  Peer already registered');
            return true;
        }
        console.error('\n  ❌ Error:', error.message);
        return false;
    }
}

// ============================================================================
// EVM Side - Register Solana peer
// ============================================================================

// EVM ↔ Solana peer registration requires TWO separate transactions:
//
//   1. setPeer(Solana, programId)
//      The Executor uses peers[chainId] as the routing address (dstAddr) when
//      building relay requests. It must point to an EXECUTABLE Solana account
//      — the program ID. Using the emitter PDA here causes InvalidProgramForExecution.
//
//   2. setVaaEmitter(Solana, emitterPda)
//      Incoming VAAs from Solana carry the Wormhole emitter PDA as their source
//      address (not the program ID). _checkPeer compares against vaaEmitters[chainId]
//      when set, so this must be registered separately.

const HELLO_WORMHOLE_ABI = [
    'function setPeer(uint16 chainId, bytes32 peerAddress) external',
    'function setVaaEmitter(uint16 chainId, bytes32 emitterAddress) external',
    'function peers(uint16 chainId) external view returns (bytes32)',
    'function vaaEmitters(uint16 chainId) external view returns (bytes32)',
];

async function registerSolanaPeerOnEvm(): Promise<boolean> {
    console.log('\n📋 EVM: Registering Solana peer (two-step)...\n');

    const wallet = loadEvmWallet();
    console.log(`  Wallet: ${wallet.address}`);

    const balance = await wallet.provider!.getBalance(wallet.address);
    console.log(`  Balance: ${ethers.formatEther(balance)} ETH`);

    const contract = new ethers.Contract(HELLO_WORMHOLE_SEPOLIA, HELLO_WORMHOLE_ABI, wallet);

    const programId = new PublicKey(HELLO_EXECUTOR_SOLANA);
    const emitterPda = deriveEmitterPda(programId);
    const programIdBytes32  = '0x' + Buffer.from(programId.toBytes()).toString('hex');
    const emitterPdaBytes32 = '0x' + Buffer.from(emitterPda.toBytes()).toString('hex');

    console.log(`  Chain ID:     ${CHAIN_ID_SOLANA} (Solana)`);
    console.log(`  Program ID:   ${programId.toBase58()}`);
    console.log(`  Emitter PDA:  ${emitterPda.toBase58()}`);

    // ── Step 1: setPeer → program ID (executor routing) ──────────────────
    const existingPeer = await contract.peers(CHAIN_ID_SOLANA);
    if (existingPeer.toLowerCase() === programIdBytes32.toLowerCase()) {
        console.log('\n  ⚠️  peers[Solana] already set to program ID — skipping');
    } else {
        try {
            console.log(`\n  Setting peers[Solana] = program ID...`);
            const tx = await contract.setPeer(CHAIN_ID_SOLANA, programIdBytes32);
            console.log(`  TX: ${tx.hash}`);
            await tx.wait();
            console.log(`  ✅ setPeer confirmed`);
        } catch (error: any) {
            console.error('\n  ❌ setPeer failed:', error.message);
            return false;
        }
    }

    // ── Step 2: setVaaEmitter → emitter PDA (VAA verification) ───────────
    const existingEmitter = await contract.vaaEmitters(CHAIN_ID_SOLANA);
    if (existingEmitter.toLowerCase() === emitterPdaBytes32.toLowerCase()) {
        console.log('  ⚠️  vaaEmitters[Solana] already set to emitter PDA — skipping');
    } else {
        try {
            console.log(`\n  Setting vaaEmitters[Solana] = emitter PDA...`);
            const tx = await contract.setVaaEmitter(CHAIN_ID_SOLANA, emitterPdaBytes32);
            console.log(`  TX: ${tx.hash}`);
            await tx.wait();
            console.log(`  ✅ setVaaEmitter confirmed`);
        } catch (error: any) {
            console.error('\n  ❌ setVaaEmitter failed:', error.message);
            return false;
        }
    }

    console.log(`\n  ✅ Solana peer registered on EVM:`);
    console.log(`     peers[1]       = program ID  (executor routing)`);
    console.log(`     vaaEmitters[1] = emitter PDA (VAA verification)`);
    return true;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    const arg = process.argv[2]?.toLowerCase();

    console.log('═'.repeat(60));
    console.log('  Cross-VM Peer Registration: EVM ↔ Solana');
    console.log('═'.repeat(60));

    let solanaOk = true;
    let evmOk = true;

    if (!arg || arg === 'solana') {
        solanaOk = await registerEvmPeerOnSolana();
    }

    if (!arg || arg === 'evm') {
        evmOk = await registerSolanaPeerOnEvm();
    }

    console.log('\n' + '═'.repeat(60));
    if (solanaOk && evmOk) {
        console.log('  ✅ All peers registered successfully!');
    } else {
        console.log('  ⚠️  Some registrations failed - check logs above');
    }
    console.log('═'.repeat(60) + '\n');
}

main().catch(console.error);
