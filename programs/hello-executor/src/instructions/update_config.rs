use anchor_lang::prelude::*;

use crate::state::Config;

#[derive(Accounts)]
pub struct UpdateWormholeConfig<'info> {
    #[account(mut)]
    /// The owner of the program.
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [Config::SEED_PREFIX],
        bump,
        has_one = owner,
    )]
    /// Config account to update.
    pub config: Account<'info, Config>,

    /// CHECK: Wormhole Core Bridge program (different on each chain).
    pub wormhole_program: UncheckedAccount<'info>,

    /// CHECK: Wormhole bridge data. Verified by PDA derivation below.
    pub wormhole_bridge: UncheckedAccount<'info>,

    /// CHECK: Wormhole fee collector. Verified by PDA derivation below.
    pub wormhole_fee_collector: UncheckedAccount<'info>,
}

pub(crate) fn handler(ctx: Context<UpdateWormholeConfig>) -> Result<()> {
    let wormhole_program = ctx.accounts.wormhole_program.key();
    
    // Verify bridge PDA
    let (expected_bridge, _) = Pubkey::find_program_address(
        &[b"Bridge"],
        &wormhole_program,
    );
    require_keys_eq!(
        ctx.accounts.wormhole_bridge.key(),
        expected_bridge,
        ErrorCode::ConstraintSeeds
    );
    
    // Verify fee_collector PDA
    let (expected_fee_collector, _) = Pubkey::find_program_address(
        &[b"fee_collector"],
        &wormhole_program,
    );
    require_keys_eq!(
        ctx.accounts.wormhole_fee_collector.key(),
        expected_fee_collector,
        ErrorCode::ConstraintSeeds
    );
    
    let config = &mut ctx.accounts.config;
    
    // Update Wormhole addresses
    config.wormhole.bridge = ctx.accounts.wormhole_bridge.key();
    config.wormhole.fee_collector = ctx.accounts.wormhole_fee_collector.key();
    
    msg!(
        "Wormhole config updated. Bridge: {}, FeeCollector: {}",
        config.wormhole.bridge,
        config.wormhole.fee_collector
    );

    Ok(())
}
