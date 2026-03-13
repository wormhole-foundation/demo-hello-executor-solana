use anchor_lang::prelude::*;
use wormhole_anchor_sdk::wormhole::{self, program::Wormhole};

use crate::{
    error::HelloExecutorError,
    message::{HelloExecutorMessage, GREETING_MAX_LENGTH},
    state::{Config, Peer, Received},
};

/// Raw message wrapper that accepts any payload bytes.
/// 
/// **Why this exists:**
/// EVM contracts (like demo-hello-executor's HelloWormhole.sol) send raw UTF-8 bytes:
///   `bytes memory payload = bytes(greeting);`
/// 
/// But Solana's HelloExecutorMessage format is structured:
///   `0x01 (Hello ID) + u16 big-endian length + message bytes`
/// 
/// Using PostedVaa<HelloExecutorMessage> would fail to deserialize EVM payloads.
/// By accepting raw bytes here, we can auto-detect the format in the handler:
/// - First byte == 0x01 → parse as HelloExecutorMessage (Solana sender)
/// - Otherwise → treat as raw UTF-8 bytes (EVM sender)
/// 
/// This enables bidirectional messaging: Solana ↔ EVM
#[derive(Clone, Debug)]
pub struct RawPayload(pub Vec<u8>);

impl AnchorDeserialize for RawPayload {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let mut buf = Vec::new();
        reader.read_to_end(&mut buf)?;
        Ok(RawPayload(buf))
    }
}

impl AnchorSerialize for RawPayload {
    fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        writer.write_all(&self.0)
    }
}

/// Type alias for the posted VAA containing raw payload bytes.
type RawVaa = wormhole::PostedVaa<RawPayload>;

#[derive(Accounts)]
#[instruction(vaa_hash: [u8; 32])]
pub struct ReceiveGreeting<'info> {
    #[account(mut)]
    /// Payer for creating the Received account.
    pub payer: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump,
    )]
    /// Config account.
    pub config: Account<'info, Config>,

    /// Wormhole Core Bridge program.
    pub wormhole_program: Program<'info, Wormhole>,

    #[account(
        seeds = [
            wormhole::SEED_PREFIX_POSTED_VAA,
            &vaa_hash,
        ],
        bump,
        seeds::program = wormhole_program.key,
    )]
    /// The verified Wormhole VAA containing the greeting.
    /// Uses RawPayload to accept any payload format.
    pub posted: Account<'info, RawVaa>,

    #[account(
        seeds = [
            Peer::SEED_PREFIX,
            &posted.emitter_chain().to_le_bytes()[..],
        ],
        bump,
        constraint = peer.verify(posted.emitter_address()) @ HelloExecutorError::UnknownEmitter,
    )]
    /// Registered peer that sent this message.
    pub peer: Account<'info, Peer>,

    #[account(
        init,
        payer = payer,
        seeds = [
            Received::SEED_PREFIX,
            &posted.emitter_chain().to_le_bytes()[..],
            &posted.sequence().to_le_bytes()[..],
        ],
        bump,
        space = 8 + Received::INIT_SPACE,
    )]
    /// Received account for replay protection.
    /// Creating this account prevents the same message from being processed twice.
    pub received: Account<'info, Received>,

    /// System program.
    pub system_program: Program<'info, System>,
}

/// Event emitted when a greeting is received.
#[event]
pub struct GreetingReceived {
    /// The greeting message.
    pub greeting: String,
    /// Chain ID of the sender.
    pub sender_chain: u16,
    /// Universal address of the sender.
    pub sender: [u8; 32],
    /// Sequence number of the Wormhole message.
    pub sequence: u64,
}

/// Payload ID for Hello message (from Solana senders)
const PAYLOAD_ID_HELLO: u8 = 1;

pub(crate) fn handler(ctx: Context<ReceiveGreeting>, vaa_hash: [u8; 32]) -> Result<()> {
    let posted = &ctx.accounts.posted;
    let payload = &posted.data().0;

    // Auto-detect payload format:
    // - If first byte is 0x01, it's HelloExecutorMessage format (from Solana)
    // - Otherwise, treat as raw bytes (from EVM)
    let message: Vec<u8> = if !payload.is_empty() && payload[0] == PAYLOAD_ID_HELLO {
        // Solana format: 0x01 (payload ID) + u16 big-endian length + message bytes
        msg!("Detected structured payload format (Solana sender)");
        
        match HelloExecutorMessage::deserialize(&mut &payload[..]) {
            Ok(HelloExecutorMessage::Hello { message }) => message,
            Ok(HelloExecutorMessage::Alive { .. }) => {
                msg!("Received Alive message, not a greeting");
                return Err(HelloExecutorError::InvalidMessage.into());
            }
            Err(e) => {
                msg!("Failed to parse as HelloExecutorMessage: {:?}", e);
                return Err(HelloExecutorError::InvalidMessage.into());
            }
        }
    } else {
        // EVM format: raw UTF-8 bytes
        msg!("Detected raw payload format (EVM sender)");
        payload.clone()
    };

    // Validate message length
    require!(
        message.len() <= GREETING_MAX_LENGTH,
        HelloExecutorError::InvalidMessage,
    );

    // Convert message to string for display
    let greeting = String::from_utf8(message.clone())
        .map_err(|_| HelloExecutorError::InvalidMessage)?;

    // Store in Received account for reference
    let received = &mut ctx.accounts.received;
    received.batch_id = posted.batch_id();
    received.wormhole_message_hash = vaa_hash;
    received.message = message;

    // Emit event
    emit!(GreetingReceived {
        greeting: greeting.clone(),
        sender_chain: posted.emitter_chain(),
        sender: *posted.emitter_address(),
        sequence: posted.sequence(),
    });

    msg!(
        "Received greeting from chain {}: \"{}\"",
        posted.emitter_chain(),
        greeting
    );

    Ok(())
}
