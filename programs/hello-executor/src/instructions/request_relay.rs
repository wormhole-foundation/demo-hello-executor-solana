use anchor_lang::prelude::*;

use crate::{
    error::HelloExecutorError,
    state::{Config, Peer, WormholeEmitter},
};

use crate::executor_cpi::{self, ExecutorProgram, RequestForExecutionArgs};

/// Arguments for requesting an Executor relay.
///
/// Solana → EVM messaging is a **two-step** process:
///
/// ```text
/// 1. send_greeting  → posts a Wormhole VAA on Solana (sequence N)
/// 2. request_relay  → pays the Executor to deliver that VAA on the EVM side
/// ```
///
/// Both steps must be called for the message to arrive. If you call `send_greeting`
/// without `request_relay`, the message is published to Wormhole but never delivered.
/// Each `send_greeting` call produces one VAA; use `sequence` to relay a specific one
/// or omit it to relay the most recently published message.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RequestRelayArgs {
    /// Wormhole chain ID of the destination chain.
    pub dst_chain: u16,
    /// Amount to pay the Executor (lamports). Get this from the Executor quote API.
    pub exec_amount: u64,
    /// Signed quote bytes from the Executor API.
    pub signed_quote_bytes: Vec<u8>,
    /// Relay instructions bytes (encodes gas limit + msgValue for the destination).
    pub relay_instructions: Vec<u8>,
    /// The specific VAA sequence to relay.
    /// - `None` / omitted → relay the most recently published message (current tracker − 1)
    /// - `Some(n)`        → relay the message at sequence `n` (useful if you skipped a relay)
    ///
    /// Note: the Wormhole sequence tracker stores the NEXT sequence to be assigned,
    /// so valid sequences are `0 ..= tracker − 1`.
    pub sequence: Option<u64>,
}

#[derive(Accounts)]
#[instruction(args: RequestRelayArgs)]
pub struct RequestRelay<'info> {
    #[account(mut)]
    /// Payer for the Executor request.
    pub payer: Signer<'info>,

    #[account(mut)]
    /// CHECK: payee is enforced by the Executor program via signed quote.
    pub payee: UncheckedAccount<'info>,

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

    /// CHECK: Wormhole sequence - verified via config address
    #[account(
        address = config.wormhole.sequence @ HelloExecutorError::InvalidWormholeSequence,
    )]
    pub wormhole_sequence: UncheckedAccount<'info>,

    /// Executor program.
    pub executor_program: Program<'info, ExecutorProgram>,

    /// System program.
    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<RequestRelay>, args: RequestRelayArgs) -> Result<()> {
    // Read the sequence tracker to validate the requested sequence is in range
    // and to derive the default (most-recent) sequence when none is specified.
    let seq_data = ctx.accounts.wormhole_sequence.try_borrow_data()?;
    let tracker = u64::from_le_bytes(seq_data[0..8].try_into().unwrap());
    drop(seq_data);

    // After initialize(), the tracker == 1 because the Alive message consumed sequence 0.
    // A tracker of 1 means send_greeting has never been called — there are no greetings
    // to relay. Relaying sequence 0 would send the Alive init message to the EVM side,
    // which would fail to parse and waste the relay fee.
    // Valid greeting sequences start at 1, so require tracker > 1 for any relayable greeting.
    require!(tracker > 1, HelloExecutorError::NoMessagesYet);

    // Resolve which VAA to relay.
    // tracker = "next sequence to be assigned" so valid greeting sequences are 1..=(tracker-1).
    let vaa_sequence = match args.sequence {
        Some(seq) => {
            // Explicitly requested sequence — must be a valid, already-published greeting.
            // seq == 0 is the Alive init message, not a greeting; reject it.
            require!(seq >= 1 && seq < tracker, HelloExecutorError::NoMessagesYet);
            seq
        }
        None => tracker - 1, // default: most-recently published greeting
    };

    // ERV1 payload: 4-byte type tag | u16 chain (BE) | 32-byte emitter | u64 sequence (BE)
    let mut request_bytes = Vec::with_capacity(4 + 2 + 32 + 8);
    request_bytes.extend_from_slice(b"ERV1");
    request_bytes.extend_from_slice(&ctx.accounts.config.chain_id.to_be_bytes());
    request_bytes.extend_from_slice(&ctx.accounts.wormhole_emitter.key().to_bytes());
    request_bytes.extend_from_slice(&vaa_sequence.to_be_bytes());

    executor_cpi::request_for_execution(
        &ctx.accounts.executor_program.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.payee.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        RequestForExecutionArgs {
            amount: args.exec_amount,
            dst_chain: args.dst_chain,
            dst_addr: ctx.accounts.peer.address,
            refund_addr: ctx.accounts.payer.key(),
            signed_quote_bytes: args.signed_quote_bytes,
            request_bytes,
            relay_instructions: args.relay_instructions,
        },
    )
}
