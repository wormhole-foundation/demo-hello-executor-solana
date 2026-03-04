use anchor_lang::prelude::*;
use wormhole_anchor_sdk::wormhole;

/// Program's Wormhole emitter account.
///
/// This account is used to sign `wormhole::post_message` CPI calls.
/// The PDA acts as the emitter for all messages from this program.
#[account]
#[derive(Default)]
pub struct WormholeEmitter {
    /// PDA bump seed.
    pub bump: u8,
}

impl WormholeEmitter {
    pub const MAXIMUM_SIZE: usize = 8 // discriminator
        + 1 // bump
    ;

    /// Seed prefix for deriving the emitter PDA.
    /// Same as wormhole's SEED_PREFIX_EMITTER.
    pub const SEED_PREFIX: &'static [u8; 7] = wormhole::SEED_PREFIX_EMITTER;
}
