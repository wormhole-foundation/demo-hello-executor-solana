#!/usr/bin/env tsx
/**
 * Send a greeting from Solana Devnet → Sepolia via Wormhole Executor
 * using the devnet ON-CHAIN QUOTER for pricing.
 *
 * Important: this still needs an off-chain configured Executor payee wallet.
 * The quote is obtained on-chain, but the payee is not currently derivable from
 * quoter/router state, so this flow is devnet-only and partially configured.
 *
 * Flow:
 *   1. send_greeting                    — post Wormhole message to Core Bridge
 *   2. request_relay_on_chain_quote     — pay via on-chain quoter router
 *
 * Usage:
 *   npx tsx e2e/sendToSepoliaOnChainQuote.ts "Hello from Solana!"
 */

import {
    Connection,
    ComputeBudgetProgram,
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
    EXECUTOR_QUOTER_ROUTER_PROGRAM,
    EXECUTOR_QUOTER_PROGRAM,
    EXECUTOR_PAYEE_DEVNET,
    QUOTER_EVM_ADDRESS,
} from './config.js';
import { createRelayInstructions } from './relay.js';
import { getCurrentSequence, pollExecutorStatus, pollForVAA } from './utils.js';

// ============================================================================
// PDA Derivations (hello-executor program)
// ============================================================================

function deriveConfigPda(programId: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
    return pda;
}

function deriveEmitterPda(programId: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('emitter')], programId);
    return pda;
}

function deriveWormholeBridge(wormholeProgram: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('Bridge')], wormholeProgram);
    return pda;
}

function deriveWormholeFeeCollector(wormholeProgram: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('fee_collector')],
        wormholeProgram
    );
    return pda;
}

function deriveWormholeSequence(wormholeProgram: PublicKey, emitter: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('Sequence'), emitter.toBuffer()],
        wormholeProgram
    );
    return pda;
}

function derivePeerPda(programId: PublicKey, chainId: number): PublicKey {
    const chainBuffer = Buffer.alloc(2);
    chainBuffer.writeUInt16LE(chainId);
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('peer'), chainBuffer],
        programId
    );
    return pda;
}

function deriveMessagePda(programId: PublicKey, sequence: bigint): PublicKey {
    const sequenceBuffer = Buffer.alloc(8);
    sequenceBuffer.writeBigUInt64LE(sequence);
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('sent'), sequenceBuffer],
        programId
    );
    return pda;
}

// ============================================================================
// PDA Derivations (quoter infrastructure)
// ============================================================================

function deriveQuoterRegistration(routerProgram: PublicKey, quoterEvmAddr: Buffer): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('quoter_registration'), quoterEvmAddr],
        routerProgram
    );
    return pda;
}

function deriveChainInfo(quoterProgram: PublicKey, dstChain: number): PublicKey {
    const chainBuffer = Buffer.alloc(2);
    chainBuffer.writeUInt16LE(dstChain);
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('chain_info'), chainBuffer],
        quoterProgram
    );
    return pda;
}

function deriveQuoteBody(quoterProgram: PublicKey, dstChain: number): PublicKey {
    const chainBuffer = Buffer.alloc(2);
    chainBuffer.writeUInt16LE(dstChain);
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('quote'), chainBuffer],
        quoterProgram
    );
    return pda;
}

function deriveQuoterConfig(quoterProgram: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('config')],
        quoterProgram
    );
    return pda;
}

function deriveRouterConfig(routerProgram: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('config')],
        routerProgram
    );
    return pda;
}

function deriveEventCpi(quoterProgram: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('__event_authority')],
        quoterProgram
    );
    return pda;
}

// ============================================================================
// Helpers
// ============================================================================

function getDiscriminator(name: string): Buffer {
    const hash = createHash('sha256');
    hash.update(`global:${name}`);
    return Buffer.from(hash.digest().slice(0, 8));
}

async function getSimulationDerivedComputeUnits(
    connection: Connection,
    payer: PublicKey,
    relayInstruction: TransactionInstruction
): Promise<number> {
    const SIMULATION_UNITS = 1_400_000;
    const FALLBACK_UNITS = 400_000;
    const HEADROOM_MULTIPLIER = 1.2;

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const simulationTx = new Transaction({
        feePayer: payer,
        recentBlockhash: blockhash,
    }).add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: SIMULATION_UNITS }),
        relayInstruction
    );

    const simulation = await connection.simulateTransaction(simulationTx);

    if (simulation.value.err) {
        console.log('Simulation did not return a usable compute estimate; using fallback 400000 CU.');
        return FALLBACK_UNITS;
    }

    const unitsConsumed = simulation.value.unitsConsumed;
    if (typeof unitsConsumed !== 'number') {
        console.log('Simulation did not report units consumed; using fallback 400000 CU.');
        return FALLBACK_UNITS;
    }

    const derivedUnits = Math.min(
        SIMULATION_UNITS,
        Math.ceil(unitsConsumed * HEADROOM_MULTIPLIER)
    );
    console.log(`Using compute unit limit ${derivedUnits} (simulated ${unitsConsumed}).`);
    return derivedUnits;
}

/**
 * Get the payee (fee recipient) for the executor relay.
 *
 * WARNING: EXECUTOR_PAYEE_DEVNET is a hardcoded wallet address extracted from the
 * Executor REST API's signed quote. It is NOT derivable from on-chain state — none
 * of the quoter/router PDAs expose it. If the relay operator rotates this wallet,
 * the hardcoded value will break and must be updated manually (or overridden via
 * the EXECUTOR_PAYEE env var).
 *
 * See config.ts for details on how this address was obtained.
 */
function getPayee(): PublicKey {
    if (process.env.EXECUTOR_PAYEE) {
        return new PublicKey(process.env.EXECUTOR_PAYEE);
    }
    return EXECUTOR_PAYEE_DEVNET;
}

function hexToBytes(hex: string): Buffer {
    const cleaned = hex.replace(/^0x/, '');
    return Buffer.from(cleaned, 'hex');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    console.log('='.repeat(60));
    console.log('  Solana Devnet -> Sepolia (Devnet On-Chain Quote)');
    console.log('='.repeat(60) + '\n');

    const greeting = process.argv[2] || 'Hello from Solana (on-chain quote)!';
    console.log(`Message: "${greeting}"`);

    // Load keypair
    const keypair = loadSolanaKeypair();
    console.log(`Wallet: ${keypair.publicKey.toBase58()}`);

    // Connect
    const connection = new Connection(config.solana.rpcUrl, 'confirmed');
    const balance = await connection.getBalance(keypair.publicKey);
    console.log(`Balance: ${balance / 1e9} SOL`);

    const programId = config.solana.programId;
    const wormholeProgram = config.solana.wormholeCoreBridge;
    const executorProgram = config.solana.executorProgram;
    const quoterRouterProgram = EXECUTOR_QUOTER_ROUTER_PROGRAM;
    const quoterProgram = EXECUTOR_QUOTER_PROGRAM;

    // Derive hello-executor PDAs
    const configPda = deriveConfigPda(programId);
    const emitterPda = deriveEmitterPda(programId);
    const wormholeBridge = deriveWormholeBridge(wormholeProgram);
    const wormholeFeeCollector = deriveWormholeFeeCollector(wormholeProgram);
    const wormholeSequence = deriveWormholeSequence(wormholeProgram, emitterPda);
    const peerPda = derivePeerPda(programId, CHAIN_ID_SEPOLIA);

    // Derive quoter infrastructure PDAs
    const quoterEvmAddr = hexToBytes(QUOTER_EVM_ADDRESS);
    const quoterRegistration = deriveQuoterRegistration(quoterRouterProgram, quoterEvmAddr);
    const quoterRouterConfig = deriveRouterConfig(quoterRouterProgram);
    const quoterChainInfo = deriveChainInfo(quoterProgram, CHAIN_ID_SEPOLIA);
    const quoterQuoteBody = deriveQuoteBody(quoterProgram, CHAIN_ID_SEPOLIA);
    const quoterConfig = deriveQuoterConfig(quoterProgram);
    const eventCpi = deriveEventCpi(quoterProgram);

    // vaaSequence = actual Wormhole VAA sequence (= tracker value)
    // pdaSequence = vaaSequence + 1 (to avoid colliding with the init message PDA slot)
    const vaaSequence = await getCurrentSequence(connection, wormholeSequence);
    const pdaSequence = vaaSequence + 1n;
    const wormholeMessage = deriveMessagePda(programId, pdaSequence);

    console.log(`\nVAA sequence:  ${vaaSequence}`);

    // Get payee (fee recipient) for the executor relay. This remains a
    // devnet configuration input even though quote pricing comes from chain state.
    const payee = getPayee();
    console.log(`Payee: ${payee.toBase58()}`);


    // == Step 1: send_greeting ================================================
    console.log('\n-- Step 1: Sending greeting message...');

    const sendDiscriminator = getDiscriminator('send_greeting');
    const greetingBytes = Buffer.from(greeting, 'utf-8');
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32LE(greetingBytes.length);
    const sendData = Buffer.concat([sendDiscriminator, lengthBuffer, greetingBytes]);

    const sendInstruction = new TransactionInstruction({
        keys: [
            { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
            { pubkey: configPda, isSigner: false, isWritable: false },
            { pubkey: wormholeProgram, isSigner: false, isWritable: false },
            { pubkey: wormholeBridge, isSigner: false, isWritable: true },
            { pubkey: wormholeFeeCollector, isSigner: false, isWritable: true },
            { pubkey: emitterPda, isSigner: false, isWritable: true },
            { pubkey: wormholeSequence, isSigner: false, isWritable: true },
            { pubkey: wormholeMessage, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ],
        programId,
        data: sendData,
    });

    const sendSig = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(sendInstruction),
        [keypair],
        { commitment: 'confirmed' }
    );

    console.log(`Transaction confirmed!`);
    console.log(`TX: ${sendSig}`);
    console.log(
        `Explorer: https://explorer.solana.com/tx/${sendSig}?cluster=devnet`
    );

    // == Step 2: request_relay_on_chain_quote ==================================
    console.log('\n-- Step 2: Requesting relay with on-chain quote...');

    const GAS_LIMIT = 200000;
    // Generous estimate for execution cost (excess handled by router/executor)
    const EXEC_AMOUNT_LAMPORTS = 100_000_000n; // 0.1 SOL

    // Relay instructions: gas limit + msgValue=0
    const relayInstructionsBytes = Buffer.from(
        createRelayInstructions(BigInt(GAS_LIMIT), 0n).slice(2),
        'hex'
    );

    // Quoter EVM address as 20-byte array
    const quoterAddrBytes = hexToBytes(QUOTER_EVM_ADDRESS);

    // Encode RequestRelayOnChainQuoteArgs via Borsh:
    //   dst_chain:          u16 LE
    //   exec_amount:        u64 LE
    //   quoter_address:     [u8; 20]
    //   relay_instructions: Vec<u8> (4-byte LE length prefix + bytes)
    //   sequence:           Option<u64> (0x01 + u64 LE = Some(n))
    const sequenceOption = Buffer.alloc(1 + 8);
    sequenceOption[0] = 0x01; // Some variant
    sequenceOption.writeBigUInt64LE(vaaSequence, 1);

    const argsBuffer = Buffer.alloc(
        2 + 8 + 20 + 4 + relayInstructionsBytes.length + sequenceOption.length
    );
    let offset = 0;
    argsBuffer.writeUInt16LE(CHAIN_ID_SEPOLIA, offset);
    offset += 2;
    argsBuffer.writeBigUInt64LE(EXEC_AMOUNT_LAMPORTS, offset);
    offset += 8;
    quoterAddrBytes.copy(argsBuffer, offset);
    offset += 20;
    argsBuffer.writeUInt32LE(relayInstructionsBytes.length, offset);
    offset += 4;
    relayInstructionsBytes.copy(argsBuffer, offset);
    offset += relayInstructionsBytes.length;
    sequenceOption.copy(argsBuffer, offset);

    const relayDiscriminator = getDiscriminator('request_relay_on_chain_quote');
    const relayData = Buffer.concat([relayDiscriminator, argsBuffer]);

    const relayInstruction = new TransactionInstruction({
        keys: [
            // hello-executor accounts
            { pubkey: keypair.publicKey, isSigner: true, isWritable: true },   // payer
            { pubkey: configPda, isSigner: false, isWritable: false },         // config
            { pubkey: peerPda, isSigner: false, isWritable: false },           // peer
            { pubkey: emitterPda, isSigner: false, isWritable: false },        // wormhole_emitter
            { pubkey: wormholeSequence, isSigner: false, isWritable: false },  // wormhole_sequence
            // quoter router infrastructure
            { pubkey: quoterRouterProgram, isSigner: false, isWritable: false }, // quoter_router_program
            { pubkey: quoterRouterConfig, isSigner: false, isWritable: false },  // quoter_router_config
            { pubkey: quoterRegistration, isSigner: false, isWritable: false },  // quoter_registration
            { pubkey: quoterProgram, isSigner: false, isWritable: false },       // quoter_program
            { pubkey: executorProgram, isSigner: false, isWritable: false },     // executor_program
            { pubkey: payee, isSigner: false, isWritable: true },                // payee
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
            // quoter program accounts
            { pubkey: quoterConfig, isSigner: false, isWritable: false },        // quoter_config
            { pubkey: quoterChainInfo, isSigner: false, isWritable: false },     // quoter_chain_info
            { pubkey: quoterQuoteBody, isSigner: false, isWritable: false },     // quoter_quote_body
            { pubkey: eventCpi, isSigner: false, isWritable: false },            // event_cpi
        ],
        programId,
        data: relayData,
    });

    const computeUnits = await getSimulationDerivedComputeUnits(
        connection,
        keypair.publicKey,
        relayInstruction
    );
    const relaySig = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
            relayInstruction
        ),
        [keypair],
        { commitment: 'confirmed' }
    );

    console.log(`Relay request confirmed!`);
    console.log(`TX: ${relaySig}`);
    console.log(
        `Explorer: https://explorer.solana.com/tx/${relaySig}?cluster=devnet`
    );

    // == Poll for completion ==================================================

    const emitterHex = Buffer.from(emitterPda.toBytes()).toString('hex');
    const vaaData = await pollForVAA(CHAIN_ID_SOLANA, emitterHex, Number(vaaSequence));

    if (vaaData) {
        console.log('\n\nVAA signed!');
    } else {
        console.log('\n\nVAA not signed within timeout');
    }

    const relayResult = await pollExecutorStatus(relaySig);

    if (relayResult?.status === 'submitted' && relayResult.txs?.length > 0) {
        const destTx = relayResult.txs[0];
        console.log('\n\nSUCCESS! Message delivered to Sepolia!');
        console.log(`   Destination TX:    ${destTx.txHash}`);
        console.log(`   Block:             ${destTx.blockNumber}`);
        console.log(`   Etherscan:         https://sepolia.etherscan.io/tx/${destTx.txHash}`);
    } else if (relayResult?.status === 'error') {
        console.log(`\n\nRelay failed: ${relayResult.failureCause || 'unknown error'}`);
    } else if (relayResult?.status === 'underpaid') {
        console.log(`\n\nRelay underpaid. Try increasing EXEC_AMOUNT_LAMPORTS.`);
    } else {
        console.log('\n\nExecutor delivery not confirmed within timeout.');
        console.log('    The relay may still be in flight — check the Executor Explorer link below.');
    }

    console.log('\n' + '-'.repeat(60));
    console.log('Links:');
    console.log(
        `  Send TX:    https://testnet.wormholescan.io/#/tx/${sendSig}`
    );
    console.log(
        `  Relay TX:   https://explorer.solana.com/tx/${relaySig}?cluster=devnet`
    );
    console.log(
        `  Executor:   https://wormholelabs-xyz.github.io/executor-explorer/#/tx/${relaySig}?endpoint=https%3A%2F%2Fexecutor-testnet.labsapis.com&env=Testnet`
    );
}

main().catch((error) => {
    console.error('\nError:', error.message || error);
    process.exit(1);
});
