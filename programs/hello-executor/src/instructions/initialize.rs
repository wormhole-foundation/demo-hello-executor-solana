use anchor_lang::prelude::*;
use anchor_lang::solana_program;
use wormhole_anchor_sdk::wormhole::{self, program::Wormhole};

use crate::{
    message::HelloExecutorMessage,
    state::{Config, WormholeEmitter},
};

use super::SEED_PREFIX_SENT;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    /// The owner who initializes the config. Will be the owner of the program.
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        seeds = [Config::SEED_PREFIX],
        bump,
        space = Config::MAXIMUM_SIZE,
    )]
    /// Config account that stores program configuration.
    pub config: Account<'info, Config>,

    /// Wormhole Core Bridge program.
    pub wormhole_program: Program<'info, Wormhole>,

    #[account(
        mut,
        seeds = [wormhole::BridgeData::SEED_PREFIX],
        bump,
        seeds::program = wormhole_program.key,
    )]
    /// Wormhole bridge data (config).
    pub wormhole_bridge: Account<'info, wormhole::BridgeData>,

    #[account(
        mut,
        seeds = [wormhole::FeeCollector::SEED_PREFIX],
        bump,
        seeds::program = wormhole_program.key,
    )]
    /// Wormhole fee collector account.
    pub wormhole_fee_collector: Account<'info, wormhole::FeeCollector>,

    #[account(
        init,
        payer = owner,
        seeds = [WormholeEmitter::SEED_PREFIX],
        bump,
        space = WormholeEmitter::MAXIMUM_SIZE,
    )]
    /// Program's Wormhole emitter account.
    pub wormhole_emitter: Account<'info, WormholeEmitter>,

    #[account(
        mut,
        seeds = [
            wormhole::SequenceTracker::SEED_PREFIX,
            wormhole_emitter.key().as_ref(),
        ],
        bump,
        seeds::program = wormhole_program.key,
    )]
    /// CHECK: Emitter's sequence account. Created by Wormhole on first message.
    pub wormhole_sequence: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [
            SEED_PREFIX_SENT,
            &wormhole::INITIAL_SEQUENCE.to_le_bytes()[..],
        ],
        bump,
    )]
    /// CHECK: Wormhole message account. Written by Wormhole program.
    pub wormhole_message: UncheckedAccount<'info>,

    /// Clock sysvar.
    pub clock: Sysvar<'info, Clock>,

    /// Rent sysvar.
    pub rent: Sysvar<'info, Rent>,

    /// System program.
    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<Initialize>, chain_id: u16) -> Result<()> {
    let config = &mut ctx.accounts.config;

    // Set the owner
    config.owner = ctx.accounts.owner.key();
    config.chain_id = chain_id;

    // Set Wormhole addresses
    {
        let wormhole = &mut config.wormhole;
        wormhole.bridge = ctx.accounts.wormhole_bridge.key();
        wormhole.fee_collector = ctx.accounts.wormhole_fee_collector.key();
        wormhole.sequence = ctx.accounts.wormhole_sequence.key();
    }

    // Set default values
    config.batch_id = 0;
    config.finality = wormhole::Finality::Finalized as u8;

    // Initialize emitter account
    ctx.accounts.wormhole_emitter.bump = ctx.bumps.wormhole_emitter;

    // Pay Wormhole fee if required
    let fee = ctx.accounts.wormhole_bridge.fee();
    if fee > 0 {
        solana_program::program::invoke(
            &solana_program::system_instruction::transfer(
                &ctx.accounts.owner.key(),
                &ctx.accounts.wormhole_fee_collector.key(),
                fee,
            ),
            &ctx.accounts.to_account_infos(),
        )?;
    }

    // Post initial "Alive" message to create sequence tracker
    let wormhole_emitter = &ctx.accounts.wormhole_emitter;
    let config = &ctx.accounts.config;

    let payload = HelloExecutorMessage::Alive {
        program_id: ctx.program_id.to_bytes(),
    }
    .try_to_vec()?;

    wormhole::post_message(
        CpiContext::new_with_signer(
            ctx.accounts.wormhole_program.to_account_info(),
            wormhole::PostMessage {
                config: ctx.accounts.wormhole_bridge.to_account_info(),
                message: ctx.accounts.wormhole_message.to_account_info(),
                emitter: wormhole_emitter.to_account_info(),
                sequence: ctx.accounts.wormhole_sequence.to_account_info(),
                payer: ctx.accounts.owner.to_account_info(),
                fee_collector: ctx.accounts.wormhole_fee_collector.to_account_info(),
                clock: ctx.accounts.clock.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[
                &[
                    SEED_PREFIX_SENT,
                    &wormhole::INITIAL_SEQUENCE.to_le_bytes()[..],
                    &[ctx.bumps.wormhole_message],
                ],
                &[WormholeEmitter::SEED_PREFIX, &[wormhole_emitter.bump]],
            ],
        ),
        config.batch_id,
        payload,
        config.finality.try_into().unwrap(),
    )?;

    msg!("HelloExecutor initialized. Owner: {}", config.owner);

    Ok(())
}
