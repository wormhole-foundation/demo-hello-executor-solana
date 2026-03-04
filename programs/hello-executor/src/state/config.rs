use anchor_lang::prelude::*;

/// Wormhole program related addresses stored in config.
#[derive(Default, AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub struct WormholeAddresses {
    /// [BridgeData](wormhole_anchor_sdk::wormhole::BridgeData) address.
    pub bridge: Pubkey,
    /// [FeeCollector](wormhole_anchor_sdk::wormhole::FeeCollector) address.
    pub fee_collector: Pubkey,
    /// [SequenceTracker](wormhole_anchor_sdk::wormhole::SequenceTracker) address.
    pub sequence: Pubkey,
}

impl WormholeAddresses {
    pub const LEN: usize = 32 + 32 + 32; // bridge + fee_collector + sequence
}

/// Program configuration account.
#[account]
#[derive(Default)]
pub struct Config {
    /// Program's owner (can register peers).
    pub owner: Pubkey,
    /// Wormhole chain ID for this deployment.
    pub chain_id: u16,
    /// Wormhole program's relevant addresses.
    pub wormhole: WormholeAddresses,
    /// AKA nonce. Just zero, but saving this information anyway.
    pub batch_id: u32,
    /// Consistency level for posted messages.
    /// u8 representation of [Finality](wormhole_anchor_sdk::wormhole::Finality).
    pub finality: u8,
}

impl Config {
    pub const MAXIMUM_SIZE: usize = 8 // discriminator
        + 32 // owner
        + 2 // chain_id
        + WormholeAddresses::LEN // wormhole addresses
        + 4 // batch_id
        + 1 // finality
    ;

    /// Seed prefix for deriving the Config PDA.
    pub const SEED_PREFIX: &'static [u8; 6] = b"config";
}
