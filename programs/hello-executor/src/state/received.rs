use anchor_lang::prelude::*;

use crate::message::GREETING_MAX_LENGTH;

/// Received message account for replay protection.
///
/// Creating this account prevents the same message from being processed twice.
/// The account stores the received greeting for reference.
#[account]
#[derive(Default)]
pub struct Received {
    /// Batch ID from the VAA (usually 0).
    pub batch_id: u32,
    /// Keccak256 hash of the verified VAA.
    pub wormhole_message_hash: [u8; 32],
    /// The received greeting message.
    pub message: Vec<u8>,
}

impl Received {
    pub const MAXIMUM_SIZE: usize = 8 // discriminator
        + 4 // batch_id
        + 32 // wormhole_message_hash
        + 4 // Vec length prefix
        + GREETING_MAX_LENGTH // message
    ;

    /// Seed prefix for deriving Received PDAs.
    pub const SEED_PREFIX: &'static [u8; 8] = b"received";
}
