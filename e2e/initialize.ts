#!/usr/bin/env tsx
/**
 * Initialize the HelloExecutor program on Solana and register peers.
 *
 * Run once after a fresh deployment:
 *   npx tsx e2e/initialize.ts
 *
 * What it does:
 *   1. Calls `initialize` — creates Config + WormholeEmitter accounts
 *   2. Calls `registerPeer` — registers the EVM contract as a peer (Sepolia)
 *
 * After this, run `setupPeers.ts evm` to register the Solana emitter PDA on the EVM side.
 *
 * TODO(redeploy): Re-run this script every time a new program binary is deployed.
 */

import {
    Connection,
    PublicKey,
    SystemProgram,
    SYSVAR_CLOCK_PUBKEY,
    SYSVAR_RENT_PUBKEY,
    Transaction,
    TransactionInstruction,
    sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createHash } from 'crypto';

import {
    config,
    loadSolanaKeypair,
    CHAIN_ID_SOLANA,
    CHAIN_ID_SEPOLIA,
    HELLO_WORMHOLE_SEPOLIA,
    evmAddressToBytes32,
    deriveEmitterPda,
} from './config.js';

function discriminator(name: string): Buffer {
    return Buffer.from(createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}

async function main() {
    const keypair = loadSolanaKeypair();
    const programId = config.solana.programId;
    const wormholeProgram = config.solana.wormholeCoreBridge;
    const connection = new Connection(config.solana.rpcUrl, 'confirmed');

    const emitterPda = deriveEmitterPda(programId);
    const emitterBytes32 = '0x' + Buffer.from(emitterPda.toBytes()).toString('hex');

    console.log('═'.repeat(60));
    console.log('  HelloExecutor: Initialize + Register Peers');
    console.log('═'.repeat(60));
    console.log(`\nProgram ID:      ${programId.toBase58()}`);
    console.log(`Owner:           ${keypair.publicKey.toBase58()}`);
    console.log(`Emitter PDA:     ${emitterPda.toBase58()}`);
    console.log(`Emitter bytes32: ${emitterBytes32}`);

    const balance = await connection.getBalance(keypair.publicKey);
    console.log(`Balance:         ${balance / 1e9} SOL\n`);

    // Derive all PDAs
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
    const [wormholeBridge] = PublicKey.findProgramAddressSync([Buffer.from('Bridge')], wormholeProgram);
    const [wormholeFeeCollector] = PublicKey.findProgramAddressSync([Buffer.from('fee_collector')], wormholeProgram);
    const [wormholeSequence] = PublicKey.findProgramAddressSync(
        [Buffer.from('Sequence'), emitterPda.toBuffer()], wormholeProgram
    );
    // wormhole::INITIAL_SEQUENCE = 1 in the wormhole-scaffolding SDK rev used here
    const seqBuf = Buffer.alloc(8);
    seqBuf.writeBigUInt64LE(1n);
    const [wormholeMessage] = PublicKey.findProgramAddressSync([Buffer.from('sent'), seqBuf], programId);

    // ── Step 1: Initialize ──────────────────────────────────────────────────
    const configExists = await connection.getAccountInfo(configPda);
    if (configExists) {
        console.log('⚠️  Config already exists — skipping initialize\n');
    } else {
        console.log('📋 Step 1: Initializing program...');
        // Args: chain_id (u16 LE)
        const initArgs = Buffer.alloc(2);
        initArgs.writeUInt16LE(CHAIN_ID_SOLANA);
        const initData = Buffer.concat([discriminator('initialize'), initArgs]);

        const initIx = new TransactionInstruction({
            programId,
            keys: [
                { pubkey: keypair.publicKey,      isSigner: true,  isWritable: true  },
                { pubkey: configPda,              isSigner: false, isWritable: true  },
                { pubkey: wormholeProgram,         isSigner: false, isWritable: false },
                { pubkey: wormholeBridge,          isSigner: false, isWritable: true  },
                { pubkey: wormholeFeeCollector,    isSigner: false, isWritable: true  },
                { pubkey: emitterPda,              isSigner: false, isWritable: true  },
                { pubkey: wormholeSequence,        isSigner: false, isWritable: true  },
                { pubkey: wormholeMessage,         isSigner: false, isWritable: true  },
                { pubkey: SYSVAR_CLOCK_PUBKEY,     isSigner: false, isWritable: false },
                { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: initData,
        });

        const tx = await sendAndConfirmTransaction(connection, new Transaction().add(initIx), [keypair], { commitment: 'confirmed' });
        console.log(`  ✅ TX: https://explorer.solana.com/tx/${tx}?cluster=devnet\n`);
    }

    // ── Step 2: Register Sepolia peer ───────────────────────────────────────
    const chainBuffer = Buffer.alloc(2);
    chainBuffer.writeUInt16LE(CHAIN_ID_SEPOLIA);
    const [peerPda] = PublicKey.findProgramAddressSync([Buffer.from('peer'), chainBuffer], programId);

    const peerExists = await connection.getAccountInfo(peerPda);
    const expectedPeerBytes = Buffer.from(evmAddressToBytes32(HELLO_WORMHOLE_SEPOLIA));
    const registeredPeerBytes = peerExists ? peerExists.data.slice(8 + 2, 8 + 2 + 32) : null;
    const peerUpToDate = registeredPeerBytes && Buffer.compare(registeredPeerBytes, expectedPeerBytes) === 0;
    if (peerExists && peerUpToDate) {
        console.log('⚠️  Sepolia peer already registered with current address — skipping\n');
    } else {
        console.log(`📋 Step 2: Registering Sepolia peer (${HELLO_WORMHOLE_SEPOLIA})...`);
        // Args: chain (u16 LE) + address ([u8; 32])
        const peerArgs = Buffer.alloc(2 + 32);
        peerArgs.writeUInt16LE(CHAIN_ID_SEPOLIA, 0);
        Buffer.from(evmAddressToBytes32(HELLO_WORMHOLE_SEPOLIA)).copy(peerArgs, 2);
        const peerData = Buffer.concat([discriminator('register_peer'), peerArgs]);

        const peerIx = new TransactionInstruction({
            programId,
            keys: [
                { pubkey: keypair.publicKey,      isSigner: true,  isWritable: true  },
                { pubkey: configPda,              isSigner: false, isWritable: false },
                { pubkey: peerPda,                isSigner: false, isWritable: true  },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: peerData,
        });

        const tx = await sendAndConfirmTransaction(connection, new Transaction().add(peerIx), [keypair], { commitment: 'confirmed' });
        console.log(`  ✅ TX: https://explorer.solana.com/tx/${tx}?cluster=devnet\n`);
    }

    console.log('═'.repeat(60));
    console.log('✅ Solana side ready!\n');
    console.log('Next: register Solana peer on EVM side (two addresses required):');
    console.log(`\n  npx tsx e2e/setupPeers.ts evm\n`);
    console.log('Or via Forge (registers both program ID and emitter PDA):');
    const programIdBytes32 = '0x' + Buffer.from(programId.toBytes()).toString('hex');
    console.log(`  HELLO_WORMHOLE_SEPOLIA_CROSSVM=<contract> \\`);
    console.log(`  SOLANA_PROGRAM_ID_BYTES32=${programIdBytes32} \\`);
    console.log(`  SOLANA_EMITTER_PDA_BYTES32=${emitterBytes32} \\`);
    console.log(`  forge script script/SetupSolanaPeer.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast`);
    console.log('═'.repeat(60));
}

main().catch((e) => { console.error('\n❌', e.message || e); process.exit(1); });
