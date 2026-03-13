use anchor_lang::prelude::*;

use crate::{
    error::HelloExecutorError,
    state::{Config, Peer},
};

#[derive(Accounts)]
#[instruction(chain: u16)]
pub struct RegisterPeer<'info> {
    #[account(mut)]
    /// Owner of the program. Must match config.owner.
    pub owner: Signer<'info>,

    #[account(
        has_one = owner @ HelloExecutorError::OwnerOnly,
        seeds = [Config::SEED_PREFIX],
        bump,
    )]
    /// Config account. Verifies the owner.
    pub config: Account<'info, Config>,

    #[account(
        // init_if_needed is intentional: allows the owner to update peer addresses
        // (e.g. after a contract upgrade on the remote chain). Safe here because
        // the has_one = owner constraint prevents anyone other than the program
        // owner from calling this instruction, making reinitialization attacks impossible.
        init_if_needed,
        payer = owner,
        seeds = [Peer::SEED_PREFIX, &chain.to_le_bytes()[..]],
        bump,
        space = 8 + Peer::INIT_SPACE,
    )]
    /// Peer account for the specified chain.
    pub peer: Account<'info, Peer>,

    /// System program.
    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<RegisterPeer>, chain: u16, address: [u8; 32]) -> Result<()> {
    // Validate the peer:
    // - Cannot be own chain ID (prevents self-registration)
    // - Cannot be zero address
    let own_chain = ctx.accounts.config.chain_id;
    require!(
        chain > 0
            && chain != own_chain
            && !address.iter().all(|&x| x == 0),
        HelloExecutorError::InvalidPeer,
    );

    // Save peer info
    let peer = &mut ctx.accounts.peer;
    peer.chain = chain;
    peer.address = address;

    msg!(
        "Registered peer on chain {}: {}",
        chain,
        hex::encode(address)
    );

    Ok(())
}
