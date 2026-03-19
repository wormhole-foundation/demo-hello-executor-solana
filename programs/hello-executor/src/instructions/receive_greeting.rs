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
/// By accepting raw bytes here, we can distinguish formats in the handler:
/// - Valid `0x01 | u16_be_len | bytes` payload → parse as HelloExecutorMessage
/// - Anything else → treat as raw UTF-8 bytes (EVM sender)
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
            posted.emitter_address(),
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

fn decode_greeting_payload(payload: &[u8]) -> Result<Vec<u8>> {
    // Structured Solana payloads use: 0x01 | u16_be_len | message bytes.
    // Only treat the payload as structured if the embedded length exactly matches.
    if payload.len() >= 3 && payload[0] == PAYLOAD_ID_HELLO {
        let declared_len = u16::from_be_bytes([payload[1], payload[2]]) as usize;
        if payload.len() == 3 + declared_len {
            msg!("Detected structured payload format (Solana sender)");
            return match HelloExecutorMessage::deserialize(&mut &payload[..]) {
                Ok(HelloExecutorMessage::Hello { message }) => Ok(message),
                Ok(HelloExecutorMessage::Alive { .. }) => {
                    Err(HelloExecutorError::InvalidMessage.into())
                }
                Err(_) => Err(HelloExecutorError::InvalidMessage.into()),
            };
        }
    }

    // EVM senders use raw UTF-8 bytes. This also preserves compatibility with
    // raw payloads whose first byte happens to be 0x01 but do not carry the
    // full Solana message header.
    msg!("Detected raw payload format (EVM sender)");
    Ok(payload.to_vec())
}

pub(crate) fn handler(ctx: Context<ReceiveGreeting>, vaa_hash: [u8; 32]) -> Result<()> {
    let posted = &ctx.accounts.posted;
    let payload = &posted.data().0;
    let message = decode_greeting_payload(payload)?;

    // Validate message length
    require!(
        message.len() <= GREETING_MAX_LENGTH,
        HelloExecutorError::InvalidMessage,
    );

    // Convert message to string for display
    let greeting =
        String::from_utf8(message.clone()).map_err(|_| HelloExecutorError::InvalidMessage)?;

    ctx.accounts.received.set_inner(Received {
        batch_id: posted.batch_id(),
        wormhole_message_hash: vaa_hash,
        message,
    });

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_structured_solana_payload() {
        let payload = HelloExecutorMessage::Hello {
            message: b"hello".to_vec(),
        }
        .try_to_vec()
        .unwrap();

        assert_eq!(
            decode_greeting_payload(&payload).unwrap(),
            b"hello".to_vec()
        );
    }

    #[test]
    fn treats_non_matching_prefixed_payload_as_raw() {
        let payload = vec![0x01, 0x00, 0x05, b'h', b'i'];
        assert_eq!(decode_greeting_payload(&payload).unwrap(), payload);
    }

    #[test]
    fn treats_truncated_structured_payload_as_raw() {
        let payload = vec![0x01, 0x00, 0x02, b'h'];
        assert_eq!(decode_greeting_payload(&payload).unwrap(), payload);
    }

    #[test]
    fn decodes_raw_evm_payload() {
        let payload = b"hello from evm".to_vec();
        assert_eq!(decode_greeting_payload(&payload).unwrap(), payload);
    }
}
