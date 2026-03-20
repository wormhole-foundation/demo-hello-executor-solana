#!/usr/bin/env tsx
/**
 * Send a greeting from Solana Devnet → Sepolia via Wormhole Executor
 * using the devnet ON-CHAIN QUOTER for pricing.
 *
 * Both the quote and the payee address are discovered on-chain — no Executor
 * REST API call is needed. The payee is obtained by simulating the quoter's
 * RequestExecutionQuote instruction.
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
    Transaction,
    TransactionInstruction,
    sendAndConfirmTransaction,
} from '@solana/web3.js';

import {
    config,
    loadSolanaKeypair,
    CHAIN_ID_SOLANA,
    CHAIN_ID_SEPOLIA,
    EXECUTOR_QUOTER_ROUTER_PROGRAM,
    EXECUTOR_QUOTER_PROGRAM,
    QUOTER_EVM_ADDRESS,
} from './config.js';
import { createRelayInstructions } from './relay.js';
import {
    buildSendGreetingInstruction,
    derivePda,
    u16le,
    u64le,
    getDiscriminator,
    getCurrentSequence,
    pollExecutorStatus,
    pollForVAA,
} from './utils.js';

// ============================================================================
// Helpers
// ============================================================================

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
 * Discover the payee (fee recipient) by simulating the quoter program's
 * RequestExecutionQuote instruction. The quoter returns 72 bytes:
 *   bytes 0-7:   required_payment (u64 BE)
 *   bytes 8-39:  payee_address (32 bytes)
 *   bytes 40-71: quote_body (32 bytes)
 *
 * This avoids hardcoding the payee — it's read from the on-chain quoter program.
 * Source: https://github.com/wormholelabs-xyz/example-messaging-executor/blob/main/svm/pinocchio/programs/executor-quoter/src/instructions/get_quote.rs
 */
async function discoverPayee(
    connection: Connection,
    payer: PublicKey,
    quoterProgram: PublicKey,
    quoterConfig: PublicKey,
    quoterChainInfo: PublicKey,
    quoterQuoteBody: PublicKey,
    eventCpi: PublicKey,
    dstChain: number,
    relayInstructionsBytes: Buffer,
): Promise<PublicKey> {
    // RequestExecutionQuote discriminator: [3, 0, 0, 0, 0, 0, 0, 0]
    const disc = Buffer.alloc(8);
    disc[0] = 3;
    const dstChainBuf = Buffer.alloc(2);
    dstChainBuf.writeUInt16LE(dstChain);
    const relayInstrLen = Buffer.alloc(4);
    relayInstrLen.writeUInt32LE(relayInstructionsBytes.length);

    const quoteIx = new TransactionInstruction({
        keys: [
            { pubkey: quoterConfig, isSigner: false, isWritable: false },
            { pubkey: quoterChainInfo, isSigner: false, isWritable: false },
            { pubkey: quoterQuoteBody, isSigner: false, isWritable: false },
            { pubkey: eventCpi, isSigner: false, isWritable: false },
        ],
        programId: quoterProgram,
        data: Buffer.concat([
            disc,
            dstChainBuf,
            Buffer.alloc(32),  // dst_addr (not needed for pricing)
            payer.toBuffer(),  // refund_addr
            Buffer.alloc(4),   // request_bytes_len = 0
            relayInstrLen, relayInstructionsBytes,
        ]),
    });

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(quoteIx);
    const sim = await connection.simulateTransaction(tx);

    if (sim.value.err) {
        throw new Error(`Payee discovery failed: ${JSON.stringify(sim.value.err)}`);
    }

    const returnData = sim.value.returnData;
    if (!returnData?.data?.[0]) {
        throw new Error('No return data from quote simulation');
    }

    const decoded = Buffer.from(returnData.data[0], 'base64');
    if (decoded.length < 40) {
        throw new Error(`Unexpected return data length: ${decoded.length} (expected 72)`);
    }
    return new PublicKey(decoded.slice(8, 40));
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
    const configPda = derivePda(programId, 'config');
    const emitterPda = derivePda(programId, 'emitter');
    const wormholeBridge = derivePda(wormholeProgram, 'Bridge');
    const wormholeFeeCollector = derivePda(wormholeProgram, 'fee_collector');
    const wormholeSequence = derivePda(wormholeProgram, 'Sequence', emitterPda.toBuffer());
    const peerPda = derivePda(programId, 'peer', u16le(CHAIN_ID_SEPOLIA));

    // Derive quoter infrastructure PDAs
    const quoterEvmAddr = hexToBytes(QUOTER_EVM_ADDRESS);
    const quoterRegistration = derivePda(quoterRouterProgram, 'quoter_registration', quoterEvmAddr);
    const quoterRouterConfig = derivePda(quoterRouterProgram, 'config');
    const quoterChainInfo = derivePda(quoterProgram, 'chain_info', u16le(CHAIN_ID_SEPOLIA));
    const quoterQuoteBody = derivePda(quoterProgram, 'quote', u16le(CHAIN_ID_SEPOLIA));
    const quoterConfig = derivePda(quoterProgram, 'config');
    const eventCpi = derivePda(quoterProgram, '__event_authority');

    // vaaSequence = actual Wormhole VAA sequence (= tracker value)
    // pdaSequence = vaaSequence + 1 (to avoid colliding with the init message PDA slot)
    const vaaSequence = await getCurrentSequence(connection, wormholeSequence);
    const pdaSequence = vaaSequence + 1n;
    const wormholeMessage = derivePda(programId, 'sent', u64le(pdaSequence));

    console.log(`\nVAA sequence:  ${vaaSequence}`);

    // Build relay instructions early — needed for both payee discovery and the relay tx
    const GAS_LIMIT = 200000;
    const relayInstructionsBytes = Buffer.from(
        createRelayInstructions(BigInt(GAS_LIMIT), 0n).slice(2),
        'hex'
    );

    // Discover payee from the on-chain quoter (no hardcoded address needed)
    const payee = await discoverPayee(
        connection,
        keypair.publicKey,
        quoterProgram,
        quoterConfig,
        quoterChainInfo,
        quoterQuoteBody,
        eventCpi,
        CHAIN_ID_SEPOLIA,
        relayInstructionsBytes,
    );
    console.log(`Payee (from quoter): ${payee.toBase58()}`);

    // == Step 1: send_greeting ================================================
    console.log('\n-- Step 1: Sending greeting message...');

    const sendInstruction = buildSendGreetingInstruction({
        payer: keypair.publicKey,
        programId,
        configPda,
        wormholeProgram,
        wormholeBridge,
        wormholeFeeCollector,
        emitterPda,
        wormholeSequence,
        wormholeMessage,
        greeting,
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

    // Generous estimate for execution cost (excess handled by router/executor)
    const EXEC_AMOUNT_LAMPORTS = 100_000_000n; // 0.1 SOL

    // Quoter EVM address as 20-byte array
    const quoterAddrBytes = hexToBytes(QUOTER_EVM_ADDRESS);

    // Encode RequestRelayOnChainQuoteArgs via Borsh (Buffer.concat, no offset math)
    const dstChainBuf = Buffer.alloc(2);
    dstChainBuf.writeUInt16LE(CHAIN_ID_SEPOLIA);
    const execAmountBuf = Buffer.alloc(8);
    execAmountBuf.writeBigUInt64LE(EXEC_AMOUNT_LAMPORTS);
    const relayInstrLenBuf = Buffer.alloc(4);
    relayInstrLenBuf.writeUInt32LE(relayInstructionsBytes.length);
    const sequenceBuf = Buffer.alloc(9);
    sequenceBuf[0] = 0x01; // Some(vaaSequence)
    sequenceBuf.writeBigUInt64LE(vaaSequence, 1);

    const relayData = Buffer.concat([
        getDiscriminator('request_relay_on_chain_quote'),
        dstChainBuf,                                   // dst_chain: u16
        execAmountBuf,                                  // exec_amount: u64
        quoterAddrBytes,                                // quoter_address: [u8; 20]
        relayInstrLenBuf, relayInstructionsBytes,       // relay_instructions: Vec<u8>
        sequenceBuf,                                    // sequence: Option<u64>
    ]);

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
