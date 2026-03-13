use anchor_lang::prelude::*;
use wormhole_anchor_sdk::wormhole;

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

    #[account(
        seeds = [wormhole::BridgeData::SEED_PREFIX],
        bump,
        seeds::program = wormhole_program.key(),
    )]
    /// CHECK: Wormhole bridge data. Verified by seeds constraint.
    pub wormhole_bridge: UncheckedAccount<'info>,

    #[account(
        seeds = [wormhole::FeeCollector::SEED_PREFIX],
        bump,
        seeds::program = wormhole_program.key(),
    )]
    /// CHECK: Wormhole fee collector. Verified by seeds constraint.
    pub wormhole_fee_collector: UncheckedAccount<'info>,
}

pub(crate) fn handler(ctx: Context<UpdateWormholeConfig>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    config.wormhole.bridge = ctx.accounts.wormhole_bridge.key();
    config.wormhole.fee_collector = ctx.accounts.wormhole_fee_collector.key();

    msg!(
        "Wormhole config updated. Bridge: {}, FeeCollector: {}",
        config.wormhole.bridge,
        config.wormhole.fee_collector
    );

    Ok(())
}
