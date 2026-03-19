use anchor_lang::prelude::*;

use crate::{
    error::HelloExecutorError,
    executor_cpi::ExecutorProgram,
    quoter_router_cpi::{self, QuoterProgram, QuoterRouterProgram},
    state::{Config, Peer, WormholeEmitter},
};

/// Arguments for requesting an Executor relay using an on-chain quote.
///
/// Like [`RequestRelayArgs`](super::request_relay::RequestRelayArgs), this requests
/// Executor relay for a published Wormhole message, but obtains the quote on-chain
/// via the Executor Quoter Router instead of requiring a pre-signed off-chain quote.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RequestRelayOnChainQuoteArgs {
    /// Wormhole chain ID of the destination chain.
    pub dst_chain: u16,
    /// Amount to pay the Executor (lamports). Should be a generous estimate;
    /// the router/executor handles excess.
    pub exec_amount: u64,
    /// EVM address of the quoter (20 bytes).
    pub quoter_address: [u8; 20],
    /// Relay instructions bytes (encodes gas limit + msgValue for the destination).
    pub relay_instructions: Vec<u8>,
    /// The specific VAA sequence to relay.
    /// - `None` → relay the most recently published message (current tracker − 1)
    /// - `Some(n)` → relay the message at sequence `n`
    pub sequence: Option<u64>,
}

#[derive(Accounts)]
#[instruction(args: RequestRelayOnChainQuoteArgs)]
pub struct RequestRelayOnChainQuote<'info> {
    #[account(mut)]
    /// Payer for the Executor request (also used as refund address).
    pub payer: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump,
    )]
    /// Config account.
    pub config: Account<'info, Config>,

    #[account(
        seeds = [Peer::SEED_PREFIX, &args.dst_chain.to_le_bytes()[..]],
        bump,
    )]
    /// Registered peer on the destination chain.
    pub peer: Account<'info, Peer>,

    #[account(
        seeds = [WormholeEmitter::SEED_PREFIX],
        bump,
    )]
    /// Program's Wormhole emitter account.
    pub wormhole_emitter: Account<'info, WormholeEmitter>,

    /// CHECK: Wormhole sequence - verified via config address.
    #[account(
        address = config.wormhole.sequence @ HelloExecutorError::InvalidWormholeSequence,
    )]
    pub wormhole_sequence: UncheckedAccount<'info>,

    /// Executor Quoter Router program.
    pub quoter_router_program: Program<'info, QuoterRouterProgram>,

    /// CHECK: Router config PDA (placeholder, currently unused by router).
    pub quoter_router_config: UncheckedAccount<'info>,

    /// CHECK: Quoter registration PDA on the router program.
    pub quoter_registration: UncheckedAccount<'info>,

    /// Executor Quoter program.
    pub quoter_program: Program<'info, QuoterProgram>,

    /// Executor program.
    pub executor_program: Program<'info, ExecutorProgram>,

    /// CHECK: Payee account — the relay operator's fee wallet. Validated downstream
    /// by the Executor/Quoter Router programs, not derivable from on-chain state.
    /// See config.ts EXECUTOR_PAYEE_DEVNET for how this address is obtained.
    #[account(mut)]
    pub payee: UncheckedAccount<'info>,

    /// System program.
    pub system_program: Program<'info, System>,

    /// CHECK: Quoter config account on the quoter program.
    pub quoter_config: UncheckedAccount<'info>,

    /// CHECK: Chain info PDA on the quoter program.
    pub quoter_chain_info: UncheckedAccount<'info>,

    /// CHECK: Quote body PDA on the quoter program.
    pub quoter_quote_body: UncheckedAccount<'info>,

    /// CHECK: Event CPI account for the quoter.
    pub event_cpi: UncheckedAccount<'info>,
}

pub(crate) fn handler(
    ctx: Context<RequestRelayOnChainQuote>,
    args: RequestRelayOnChainQuoteArgs,
) -> Result<()> {
    let quoter_router_program_id = ctx.accounts.quoter_router_program.key();
    let quoter_program_id = ctx.accounts.quoter_program.key();

    let (expected_router_config, _) = quoter_router_cpi::derive_config(&quoter_router_program_id);
    require_keys_eq!(
        ctx.accounts.quoter_router_config.key(),
        expected_router_config,
        HelloExecutorError::InvalidQuoterAccount
    );

    let (expected_quoter_registration, _) = quoter_router_cpi::derive_quoter_registration(
        &quoter_router_program_id,
        &args.quoter_address,
    );
    require_keys_eq!(
        ctx.accounts.quoter_registration.key(),
        expected_quoter_registration,
        HelloExecutorError::InvalidQuoterAccount
    );

    let (expected_quoter_config, _) = quoter_router_cpi::derive_config(&quoter_program_id);
    require_keys_eq!(
        ctx.accounts.quoter_config.key(),
        expected_quoter_config,
        HelloExecutorError::InvalidQuoterAccount
    );

    let (expected_chain_info, _) =
        quoter_router_cpi::derive_chain_info(&quoter_program_id, args.dst_chain);
    require_keys_eq!(
        ctx.accounts.quoter_chain_info.key(),
        expected_chain_info,
        HelloExecutorError::InvalidQuoterAccount
    );

    let (expected_quote_body, _) =
        quoter_router_cpi::derive_quote_body(&quoter_program_id, args.dst_chain);
    require_keys_eq!(
        ctx.accounts.quoter_quote_body.key(),
        expected_quote_body,
        HelloExecutorError::InvalidQuoterAccount
    );

    let (expected_event_cpi, _) = quoter_router_cpi::derive_event_authority(&quoter_program_id);
    require_keys_eq!(
        ctx.accounts.event_cpi.key(),
        expected_event_cpi,
        HelloExecutorError::InvalidQuoterAccount
    );

    // ── Sequence validation (same as request_relay) ──────────────────────────
    // After initialize(), the tracker == 1 because the Alive message consumed sequence 0.
    // That means there are no user greeting messages yet — nothing worth paying
    // to relay. Relaying sequence 0 would send the Alive init message to the EVM side,
    // which is not useful.
    // Valid greeting sequences start at 1, so require tracker > 1 for any relayable greeting.
    let seq_data = ctx.accounts.wormhole_sequence.try_borrow_data()?;
    let tracker = u64::from_le_bytes(seq_data[0..8].try_into().unwrap());
    drop(seq_data);

    require!(tracker > 1, HelloExecutorError::NoMessagesYet);

    let vaa_sequence = match args.sequence {
        Some(seq) => {
            require!(seq >= 1 && seq < tracker, HelloExecutorError::NoMessagesYet);
            seq
        }
        None => tracker - 1,
    };

    // ── Build ERV1 request bytes ─────────────────────────────────────────────
    let mut request_bytes = Vec::with_capacity(4 + 2 + 32 + 8);
    request_bytes.extend_from_slice(b"ERV1");
    request_bytes.extend_from_slice(&ctx.accounts.config.chain_id.to_be_bytes());
    request_bytes.extend_from_slice(&ctx.accounts.wormhole_emitter.key().to_bytes());
    request_bytes.extend_from_slice(&vaa_sequence.to_be_bytes());

    // ── CPI to Quoter Router ─────────────────────────────────────────────────
    quoter_router_cpi::request_execution_on_chain_quote(
        &ctx.accounts.quoter_router_program.to_account_info(),
        &ctx.accounts.quoter_program.to_account_info(),
        &ctx.accounts.executor_program.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.quoter_router_config.to_account_info(),
        &ctx.accounts.quoter_registration.to_account_info(),
        &ctx.accounts.payee.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.quoter_config.to_account_info(),
        &ctx.accounts.quoter_chain_info.to_account_info(),
        &ctx.accounts.quoter_quote_body.to_account_info(),
        &ctx.accounts.event_cpi.to_account_info(),
        args.exec_amount,
        &args.quoter_address,
        args.dst_chain,
        &ctx.accounts.peer.address,
        &ctx.accounts.payer.key(),
        &request_bytes,
        &args.relay_instructions,
    )
}
