use anchor_lang::prelude::*;

/// Registered peer contract on another chain.
#[account]
#[derive(Default)]
pub struct Peer {
    /// Wormhole chain ID of the peer.
    pub chain: u16,
    /// Universal address (32 bytes) of the peer contract.
    pub address: [u8; 32],
}

impl Peer {
    pub const MAXIMUM_SIZE: usize = 8 // discriminator
        + 2 // chain
        + 32 // address
    ;

    /// Seed prefix for deriving Peer PDAs.
    pub const SEED_PREFIX: &'static [u8; 4] = b"peer";

    /// Verify that the given address matches this peer.
    pub fn verify(&self, address: &[u8; 32]) -> bool {
        *address == self.address
    }
}
