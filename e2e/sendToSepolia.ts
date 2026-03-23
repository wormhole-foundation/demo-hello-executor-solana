#!/usr/bin/env tsx
/**
 * Send a greeting from Solana Devnet → Sepolia via Wormhole Executor
 *
 * Flow:
 *   1. send_greeting   — post Wormhole message to Core Bridge
 *   2. request_relay   — pay the Executor to relay the VAA to Sepolia
 *
 * Usage:
 *   npx tsx e2e/sendToSepolia.ts "Hello from Solana!"
 */

import {
    Connection,
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
    EXECUTOR_API,
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

/**
 * Get a signed quote from the Executor API for Solana → EVM relay.
 * Returns the signed quote bytes and the estimated cost in lamports.
 */
async function getExecutorQuote(
    dstChain: number,
    gasLimit: number
): Promise<{ signedQuoteBytes: Buffer; payee: PublicKey; execAmountLamports: bigint }> {
    // Relay instructions: 0x01 | uint128 gasLimit | uint128 msgValue=0
    const relayInstructions = createRelayInstructions(BigInt(gasLimit), 0n);

    const response = await fetch(`${EXECUTOR_API}/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            srcChain: CHAIN_ID_SOLANA,
            dstChain,
            relayInstructions,
        }),
    });

    if (!response.ok) {
        throw new Error(`Executor quote failed: ${await response.text()}`);
    }

    const data = (await response.json()) as { signedQuote: string; estimatedCost?: string };
    const hexQuote = data.signedQuote.startsWith('0x')
        ? data.signedQuote.slice(2)
        : data.signedQuote;
    const quoteBytes = Buffer.from(hexQuote, 'hex');

    // EQ01 layout: prefix(4) + quoterAddr(20) + payeeAddr(32) + ...
    const prefix = quoteBytes.slice(0, 4).toString('ascii');
    if (prefix !== 'EQ01') throw new Error(`Unknown quote prefix: ${prefix}`);

    const payee = new PublicKey(quoteBytes.slice(24, 56));

    // estimatedCost is in lamports (source chain native units)
    const execAmountLamports = BigInt(data.estimatedCost || '200000');

    return { signedQuoteBytes: quoteBytes, payee, execAmountLamports };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    console.log('═'.repeat(60));
    console.log('  🌊 Solana Devnet → Sepolia');
    console.log('═'.repeat(60) + '\n');

    const greeting = process.argv[2] || 'Hello from Solana! 🌊';
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

    // Derive PDAs
    const configPda = derivePda(programId, 'config');
    const emitterPda = derivePda(programId, 'emitter');
    const wormholeBridge = derivePda(wormholeProgram, 'Bridge');
    const wormholeFeeCollector = derivePda(wormholeProgram, 'fee_collector');
    const wormholeSequence = derivePda(wormholeProgram, 'Sequence', emitterPda.toBuffer());
    const peerPda = derivePda(programId, 'peer', u16le(CHAIN_ID_SEPOLIA));

    // vaaSequence = actual Wormhole VAA sequence (= tracker value)
    // pdaSequence = vaaSequence + 1 (to avoid colliding with the init message PDA slot)
    const vaaSequence = await getCurrentSequence(connection, wormholeSequence);
    const pdaSequence = vaaSequence + 1n;
    const wormholeMessage = derivePda(programId, 'sent', u64le(pdaSequence));

    console.log(`\nVAA sequence:  ${vaaSequence}`);
    console.log(`Message PDA slot: ${pdaSequence}`);
    console.log(`Emitter PDA: ${emitterPda.toBase58()}`);

    // ── Step 1: send_greeting ───────────────────────────────────────────────
    console.log('\n📤 Step 1: Sending greeting message...');

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

    console.log(`✅ Transaction confirmed!`);
    console.log(`TX: ${sendSig}`);
    console.log(
        `Explorer: https://explorer.solana.com/tx/${sendSig}?cluster=devnet`
    );

    // ── Step 2: request_relay ───────────────────────────────────────────────
    console.log('\n📡 Step 2: Requesting Executor relay...');

    const GAS_LIMIT = 200000; // EVM gas for receiveWormholeMessages
    const quote = await getExecutorQuote(CHAIN_ID_SEPOLIA, GAS_LIMIT);

    console.log(`  Payee: ${quote.payee.toBase58()}`);
    console.log(
        `  Exec amount: ${quote.execAmountLamports} lamports (${Number(quote.execAmountLamports) / 1e9} SOL)`
    );

    // Encode relay instructions as bytes (same value as used in getExecutorQuote above)
    const relayInstructionsBytes = Buffer.from(
        createRelayInstructions(BigInt(GAS_LIMIT), 0n).slice(2), // strip '0x'
        'hex'
    );

    // Encode RequestRelayArgs via Borsh:
    //   dst_chain:             u16 LE
    //   exec_amount:           u64 LE
    //   signed_quote_bytes:    Vec<u8>    (4-byte LE length prefix + bytes)
    //   relay_instructions:    Vec<u8>    (4-byte LE length prefix + bytes)
    //   sequence:              Option<u64> (0x00 = None, 0x01 + u64 LE = Some(n))
    //
    // We pass Some(vaaSequence) to relay exactly the message we just sent,
    // rather than relying on "latest message" defaulting logic.
    const sequenceOption = Buffer.alloc(1 + 8);
    sequenceOption[0] = 0x01; // Some variant
    sequenceOption.writeBigUInt64LE(vaaSequence, 1);

    const requestRelayDiscriminator = getDiscriminator('request_relay');
    const argsBuffer = Buffer.alloc(
        2 + 8 + 4 + quote.signedQuoteBytes.length + 4 + relayInstructionsBytes.length + sequenceOption.length
    );
    let offset = 0;
    argsBuffer.writeUInt16LE(CHAIN_ID_SEPOLIA, offset);
    offset += 2;
    argsBuffer.writeBigUInt64LE(quote.execAmountLamports, offset);
    offset += 8;
    argsBuffer.writeUInt32LE(quote.signedQuoteBytes.length, offset);
    offset += 4;
    quote.signedQuoteBytes.copy(argsBuffer, offset);
    offset += quote.signedQuoteBytes.length;
    argsBuffer.writeUInt32LE(relayInstructionsBytes.length, offset);
    offset += 4;
    relayInstructionsBytes.copy(argsBuffer, offset);
    offset += relayInstructionsBytes.length;
    sequenceOption.copy(argsBuffer, offset);

    const relayData = Buffer.concat([requestRelayDiscriminator, argsBuffer]);

    const relayInstruction = new TransactionInstruction({
        keys: [
            { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
            { pubkey: quote.payee, isSigner: false, isWritable: true },
            { pubkey: configPda, isSigner: false, isWritable: false },
            { pubkey: peerPda, isSigner: false, isWritable: false },
            { pubkey: emitterPda, isSigner: false, isWritable: false },
            { pubkey: wormholeSequence, isSigner: false, isWritable: false },
            { pubkey: executorProgram, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId,
        data: relayData,
    });

    const relaySig = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(relayInstruction),
        [keypair],
        { commitment: 'confirmed' }
    );

    console.log(`✅ Relay request confirmed!`);
    console.log(`TX: ${relaySig}`);
    console.log(
        `Explorer: https://explorer.solana.com/tx/${relaySig}?cluster=devnet`
    );

    // ── Poll for completion ─────────────────────────────────────────────────

    const emitterHex = Buffer.from(emitterPda.toBytes()).toString('hex');
    const vaaData = await pollForVAA(CHAIN_ID_SOLANA, emitterHex, Number(vaaSequence));

    if (vaaData) {
        console.log('\n\n✅ VAA signed!');
    } else {
        console.log('\n\n⚠️  VAA not signed within timeout');
    }

    // Poll executor status for the relay request TX.
    // "submitted" (with txs[]) = delivered to Sepolia; "error"/"underpaid" = failure.
    const relayResult = await pollExecutorStatus(relaySig);

    if (relayResult?.status === 'submitted' && relayResult.txs?.length > 0) {
        const destTx = relayResult.txs[0];
        console.log('\n\n🎉 SUCCESS! Message delivered to Sepolia!');
        console.log(`   Destination TX:    ${destTx.txHash}`);
        console.log(`   Block:             ${destTx.blockNumber}`);
        console.log(`   Etherscan:         https://sepolia.etherscan.io/tx/${destTx.txHash}`);
    } else if (relayResult?.status === 'error') {
        console.log(`\n\n❌ Relay failed: ${relayResult.failureCause || 'unknown error'}`);
    } else if (relayResult?.status === 'underpaid') {
        console.log(`\n\n❌ Relay underpaid. Try increasing execAmount in getExecutorQuote()`);
    } else {
        console.log('\n\n⚠️  Executor delivery not confirmed within timeout.');
        console.log('    The relay may still be in flight — check the Executor Explorer link below.');
    }

    console.log('\n' + '─'.repeat(60));
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
    console.error('\n❌ Error:', error.message || error);
    process.exit(1);
});
