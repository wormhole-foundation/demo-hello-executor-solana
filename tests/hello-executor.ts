import { PublicKey } from '@solana/web3.js';
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load IDL directly
const idlPath = path.join(__dirname, '..', 'target', 'idl', 'hello_executor.json');
const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));

// Program ID matches [programs.localnet] in Anchor.toml.
// These tests are structural (IDL + PDA derivation only) — they do NOT make
// on-chain transactions, so they work against both localnet and devnet.
const PROGRAM_ID = new PublicKey('7eiTqf1b1dNwpzn27qEr4eGSWnuon2fJTbnTuWcFifZG');

// Wormhole Core Bridge on devnet
const WORMHOLE_PROGRAM = new PublicKey('3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5');

describe('hello-executor', () => {
    // Derive PDAs
    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('config')],
        PROGRAM_ID
    );

    const [emitterPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('emitter')],
        PROGRAM_ID
    );

    const [wormholeBridge] = PublicKey.findProgramAddressSync(
        [Buffer.from('Bridge')],
        WORMHOLE_PROGRAM
    );

    const [wormholeFeeCollector] = PublicKey.findProgramAddressSync(
        [Buffer.from('fee_collector')],
        WORMHOLE_PROGRAM
    );

    const [wormholeSequence] = PublicKey.findProgramAddressSync(
        [Buffer.from('Sequence'), emitterPda.toBuffer()],
        WORMHOLE_PROGRAM
    );

    it('Derives correct PDAs', () => {
        console.log('Program ID:', PROGRAM_ID.toBase58());
        console.log('Config PDA:', configPda.toBase58());
        console.log('Emitter PDA:', emitterPda.toBase58());
        console.log('Wormhole Bridge:', wormholeBridge.toBase58());
        console.log('Fee Collector:', wormholeFeeCollector.toBase58());
        console.log('Sequence:', wormholeSequence.toBase58());

        // Verify PDAs are derived correctly
        expect(configPda).to.not.be.null;
        expect(emitterPda).to.not.be.null;
        expect(wormholeBridge.toBase58()).to.equal('6bi4JGDoRwUs9TYBuvoA7dUVyikTJDrJsJU1ew6KVLiu');
        expect(wormholeFeeCollector.toBase58()).to.equal('7s3a1ycs16d6SNDumaRtjcoyMaTDZPavzgsmS3uUZYWX');
    });

    it('Can derive peer PDA for different chains', () => {
        const testChains = [
            { id: 2, name: 'Ethereum' },
            { id: 51, name: 'Fogo' },
        ];

        for (const chain of testChains) {
            const chainBuffer = Buffer.alloc(2);
            chainBuffer.writeUInt16LE(chain.id);

            const [peerPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('peer'), chainBuffer],
                PROGRAM_ID
            );

            console.log(`Peer PDA for ${chain.name} (${chain.id}):`, peerPda.toBase58());
            expect(peerPda).to.not.be.null;
        }
    });

    it('Can derive received PDA for message tracking', () => {
        const emitterChain = 2;
        const sequence = BigInt(12345);

        const chainBuffer = Buffer.alloc(2);
        chainBuffer.writeUInt16LE(emitterChain);
        const sequenceBuffer = Buffer.alloc(8);
        sequenceBuffer.writeBigUInt64LE(sequence);

        const [receivedPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('received'), chainBuffer, sequenceBuffer],
            PROGRAM_ID
        );

        console.log('Received PDA:', receivedPda.toBase58());
        expect(receivedPda).to.not.be.null;
    });

    it('Has correct IDL structure', () => {
        // Verify IDL has the expected instructions
        const instructionNames = idl.instructions?.map((i: any) => i.name) || [];
        console.log('Instructions:', instructionNames);

        expect(instructionNames).to.include('initialize');
        expect(instructionNames).to.include('registerPeer');
        expect(instructionNames).to.include('sendGreeting');
        expect(instructionNames).to.include('receiveGreeting');
        expect(instructionNames).to.include('requestRelay');
        expect(instructionNames).to.include('resolveExecuteVaaV1');
    });

    it('Has correct account definitions', () => {
        // Verify IDL has the expected accounts
        const accountNames = idl.accounts?.map((a: any) => a.name) || [];
        console.log('Accounts:', accountNames);

        expect(accountNames).to.include('Config');
        expect(accountNames).to.include('Peer');
        expect(accountNames).to.include('Received');
        expect(accountNames).to.include('WormholeEmitter');
    });

    it('Has correct error definitions', () => {
        // Verify IDL has the expected errors
        const errorNames = idl.errors?.map((e: any) => e.name) || [];
        console.log('Errors:', errorNames);

        expect(errorNames).to.include('InvalidWormholeConfig');
        expect(errorNames).to.include('InvalidPeer');
        expect(errorNames).to.include('UnknownEmitter');
        expect(errorNames).to.include('InvalidMessage');
    });

    it('Has events defined', () => {
        // Verify IDL has the expected events
        const eventNames = idl.events?.map((e: any) => e.name) || [];
        console.log('Events:', eventNames);

        expect(eventNames).to.include('GreetingSent');
        expect(eventNames).to.include('GreetingReceived');
    });
});
