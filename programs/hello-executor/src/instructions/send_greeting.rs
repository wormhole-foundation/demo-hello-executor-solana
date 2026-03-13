use anchor_lang::prelude::*;
use anchor_lang::solana_program::{self, instruction::Instruction, program::invoke_signed};

use crate::{
    error::HelloExecutorError,
    message::{HelloExecutorMessage, GREETING_MAX_LENGTH},
    state::{Config, WormholeEmitter},
};

use super::SEED_PREFIX_SENT;

#[derive(Accounts)]
pub struct SendGreeting<'info> {
    #[account(mut)]
    /// Payer for the Wormhole fee and message account.
    pub payer: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump,
    )]
    /// Config account with Wormhole addresses.
    pub config: Account<'info, Config>,

    /// CHECK: Wormhole Core Bridge program - any chain's Wormhole program
    pub wormhole_program: UncheckedAccount<'info>,

    /// CHECK: Wormhole bridge data - verified by config.wormhole.bridge
    #[account(
        mut,
        address = config.wormhole.bridge @ HelloExecutorError::InvalidWormholeConfig,
    )]
    pub wormhole_bridge: UncheckedAccount<'info>,

    /// CHECK: Wormhole fee collector - verified by config
    #[account(
        mut,
        address = config.wormhole.fee_collector @ HelloExecutorError::InvalidWormholeFeeCollector,
    )]
    pub wormhole_fee_collector: UncheckedAccount<'info>,

    #[account(
        seeds = [WormholeEmitter::SEED_PREFIX],
        bump,
    )]
    /// Program's emitter account.
    pub wormhole_emitter: Account<'info, WormholeEmitter>,

    /// CHECK: Emitter's sequence account
    #[account(mut)]
    pub wormhole_sequence: UncheckedAccount<'info>,

    /// CHECK: Wormhole message account. Written by Wormhole program.
    #[account(mut)]
    pub wormhole_message: UncheckedAccount<'info>,

    /// System program.
    pub system_program: Program<'info, System>,

    /// Clock sysvar.
    pub clock: Sysvar<'info, Clock>,

    /// Rent sysvar.
    pub rent: Sysvar<'info, Rent>,
}

/// Event emitted when a greeting is sent.
#[event]
pub struct GreetingSent {
    /// The greeting message.
    pub greeting: String,
    /// Sequence number of the Wormhole message.
    pub sequence: u64,
    /// Timestamp of the transaction.
    pub timestamp: i64,
}

pub(crate) fn handler(ctx: Context<SendGreeting>, greeting: String) -> Result<()> {
    // Validate message length
    require!(
        greeting.len() <= GREETING_MAX_LENGTH,
        HelloExecutorError::MessageTooLarge,
    );

    // Read fee from bridge account (BridgeData layout has no Anchor discriminator)
    let bridge_data = ctx.accounts.wormhole_bridge.try_borrow_data()?;
    const BRIDGE_FEE_OFFSET: usize = 4 + 8 + 4; // guardian_set_index + last_lamports + expiration_time
    let fee = u64::from_le_bytes(
        bridge_data
            .get(BRIDGE_FEE_OFFSET..BRIDGE_FEE_OFFSET + 8)
            .ok_or(HelloExecutorError::InvalidWormholeConfig)?
            .try_into()
            .unwrap(),
    );
    drop(bridge_data);

    // Pay Wormhole fee if required
    if fee > 0 {
        solana_program::program::invoke(
            &solana_program::system_instruction::transfer(
                &ctx.accounts.payer.key(),
                &ctx.accounts.wormhole_fee_collector.key(),
                fee,
            ),
            &ctx.accounts.to_account_infos(),
        )?;
    }

    // Read the Wormhole sequence tracker.
    //
    // The tracker stores the sequence number Wormhole will assign to the NEXT
    // post_message call — i.e. the actual VAA sequence for THIS message.
    //
    // The message PDA uses `vaa_sequence + 1` to avoid colliding with the init
    // message PDA, which was seeded with `wormhole::INITIAL_SEQUENCE` (= the
    // tracker value right after initialize()).
    let seq_data = ctx.accounts.wormhole_sequence.try_borrow_data()?;
    let vaa_sequence = if seq_data.len() >= 8 {
        u64::from_le_bytes(seq_data[0..8].try_into().unwrap())
    } else {
        0
    };
    drop(seq_data);
    // PDA slot = vaa_sequence + 1 (avoids the init-time PDA at slot vaa_sequence)
    let pda_sequence = vaa_sequence + 1;

    let wormhole_emitter = &ctx.accounts.wormhole_emitter;
    let config = &ctx.accounts.config;

    // Encode the greeting as payload
    let payload = HelloExecutorMessage::Hello {
        message: greeting.as_bytes().to_vec(),
    }
    .try_to_vec()?;

    // Build wormhole post_message instruction (raw CPI)
    // Wormhole uses 1-byte instruction discriminator: PostMessage = 1
    // Data format: [discriminator(1) | nonce(4) | payload_len(4) | payload | consistency(1)]
    let mut ix_data = Vec::with_capacity(1 + 4 + 4 + payload.len() + 1);
    ix_data.push(0x01); // PostMessage instruction
    ix_data.extend_from_slice(&config.batch_id.to_le_bytes()); // nonce (u32)
    ix_data.extend_from_slice(&(payload.len() as u32).to_le_bytes()); // payload length
    ix_data.extend_from_slice(&payload);
    ix_data.push(config.finality); // consistency level

    let ix = Instruction {
        program_id: ctx.accounts.wormhole_program.key(),
        accounts: vec![
            AccountMeta::new(ctx.accounts.wormhole_bridge.key(), false),
            AccountMeta::new(ctx.accounts.wormhole_message.key(), true),
            AccountMeta::new_readonly(wormhole_emitter.key(), true),
            AccountMeta::new(ctx.accounts.wormhole_sequence.key(), false),
            AccountMeta::new(ctx.accounts.payer.key(), true),
            AccountMeta::new(ctx.accounts.wormhole_fee_collector.key(), false),
            AccountMeta::new_readonly(ctx.accounts.clock.key(), false),
            AccountMeta::new_readonly(ctx.accounts.rent.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        ],
        data: ix_data,
    };

    // Derive the message PDA bump using pda_sequence
    let pda_seq_buf = pda_sequence.to_le_bytes();
    let (_, message_bump) = Pubkey::find_program_address(
        &[SEED_PREFIX_SENT, &pda_seq_buf],
        ctx.program_id,
    );

    invoke_signed(
        &ix,
        &ctx.accounts.to_account_infos(),
        &[
            &[SEED_PREFIX_SENT, &pda_seq_buf, &[message_bump]],
            &[WormholeEmitter::SEED_PREFIX, &[wormhole_emitter.bump]],
        ],
    )?;

    // Emit event with the ACTUAL VAA sequence (what the relay/explorer will see)
    let clock = &ctx.accounts.clock;
    emit!(GreetingSent {
        greeting,
        sequence: vaa_sequence,
        timestamp: clock.unix_timestamp,
    });

    msg!("Greeting sent! VAA sequence: {}", vaa_sequence);

    Ok(())
}
