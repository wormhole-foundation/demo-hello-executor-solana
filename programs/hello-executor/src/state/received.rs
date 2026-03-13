use anchor_lang::prelude::*;

use crate::message::GREETING_MAX_LENGTH;

/// Received message account for replay protection.
///
/// Creating this account prevents the same message from being processed twice.
/// The account stores the received greeting for reference.
#[account]
#[derive(Default, InitSpace)]
pub struct Received {
    /// Batch ID from the VAA (usually 0).
    pub batch_id: u32,
    /// Keccak256 hash of the verified VAA.
    pub wormhole_message_hash: [u8; 32],
    /// The received greeting message.
    #[max_len(GREETING_MAX_LENGTH)]
    pub message: Vec<u8>,
}

impl Received {
    /// Seed prefix for deriving Received PDAs.
    pub const SEED_PREFIX: &'static [u8; 8] = b"received";
}
