//! Executor resolver for Wormhole Executor VAA execution.
//!
//! This module handles the resolve_execute_vaa_v1 instruction that returns
//! the instructions needed to execute a VAA on this program.

use anchor_lang::prelude::*;
use anchor_lang::InstructionData;
use executor_account_resolver_svm::{
    InstructionGroup, InstructionGroups, Resolver, SerializableAccountMeta,
    SerializableInstruction, RESOLVER_PUBKEY_PAYER, RESOLVER_PUBKEY_POSTED_VAA,
};
use solana_program::program::set_return_data;

use wormhole_anchor_sdk::wormhole;

use crate::state::{Config, Peer, Received};

#[derive(Accounts)]
pub struct ExecuteVaaV1<'info> {
    #[account(seeds = [Config::SEED_PREFIX], bump)]
    pub config: Account<'info, Config>,
    pub wormhole_program: Program<'info, wormhole::program::Wormhole>,
    pub system_program: Program<'info, System>,
}

// Re-export types for lib.rs
pub use executor_account_resolver_svm::{InstructionGroups as ResolverInstructionGroups, Resolver as ResolverType};

// ============ Handlers ============

fn parse_vaa_body(vaa_body: &[u8]) -> Result<(u16, [u8; 32], u64)> {
    // VAA body layout:
    // timestamp(4) | nonce(4) | emitter_chain(2) | emitter_address(32) | sequence(8) | consistency(1) | payload(...)
    if vaa_body.len() < 51 {
        return Err(ProgramError::InvalidInstructionData.into());
    }

    let emitter_chain = u16::from_be_bytes(
        vaa_body[8..10]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );

    let mut emitter_address = [0u8; 32];
    emitter_address.copy_from_slice(&vaa_body[10..42]);

    let sequence = u64::from_be_bytes(
        vaa_body[42..50]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );

    Ok((emitter_chain, emitter_address, sequence))
}

/// Handle resolver call via Anchor Context.
pub(crate) fn handle_resolve(
    ctx: Context<ExecuteVaaV1>,
    vaa_body: Vec<u8>,
) -> Result<Resolver<InstructionGroups>> {
    let result = build_resolver_result(
        &crate::ID,
        &ctx.accounts.config.key(),
        &ctx.accounts.wormhole_program.key(),
        &ctx.accounts.system_program.key(),
        &vaa_body,
    )?;

    // Also set as return data for the executor
    let mut result_data = Vec::new();
    result.serialize(&mut result_data)?;
    set_return_data(&result_data);

    Ok(result)
}

/// Handle resolver call via raw accounts (for fallback).
/// The executor calls this with minimal/no accounts - we derive everything from program ID.
pub(crate) fn handle_resolve_raw<'info>(
    program_id: &Pubkey,
    _accounts: &'info [AccountInfo<'info>],
    data: &[u8],
) -> Result<()> {
    msg!("handle_resolve_raw called");

    // Parse vaa_body from Borsh-encoded data
    if data.len() < 4 {
        msg!("Data too short");
        return Err(ProgramError::InvalidInstructionData.into());
    }
    let vaa_len = u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize;
    if data.len() < 4 + vaa_len {
        msg!("VAA data truncated");
        return Err(ProgramError::InvalidInstructionData.into());
    }
    let vaa_body = &data[4..4 + vaa_len];

    // Derive all required PDAs from program ID - executor doesn't pass accounts
    let (config_key, _) = Pubkey::find_program_address(&[Config::SEED_PREFIX], program_id);
    
    // Wormhole Core Bridge address (resolved via feature flags: solana-devnet, mainnet, etc.)
    let wormhole_program_key = wormhole::program::ID;
    let system_program_key = solana_program::system_program::ID;

    let result = build_resolver_result(
        program_id,
        &config_key,
        &wormhole_program_key,
        &system_program_key,
        vaa_body,
    )?;

    // Serialize and set as return data
    let mut result_data = Vec::new();
    result.serialize(&mut result_data)?;
    msg!("Returning {} bytes", result_data.len());
    set_return_data(&result_data);

    Ok(())
}

/// Build the resolver result containing the instruction to execute.
/// 
/// Uses RESOLVER_PUBKEY_POSTED_VAA placeholder to tell the Executor to:
/// 1. First post the VAA to the Wormhole Core Bridge
/// 2. Replace the placeholder with the actual posted_vaa address
fn build_resolver_result(
    program_id: &Pubkey,
    config_key: &Pubkey,
    wormhole_program_key: &Pubkey,
    system_program_key: &Pubkey,
    vaa_body: &[u8],
) -> Result<Resolver<InstructionGroups>> {
    let vaa_hash = solana_program::keccak::hashv(&[vaa_body]).to_bytes();
    let (emitter_chain, _emitter_address, sequence) = parse_vaa_body(vaa_body)?;
    
    msg!("Building resolver for chain {} seq {}", emitter_chain, sequence);

    // Derive PDAs for peer and received (these are program-specific)
    let (peer, _) = Pubkey::find_program_address(
        &[Peer::SEED_PREFIX, &emitter_chain.to_le_bytes()],
        program_id,
    );

    let (received, _) = Pubkey::find_program_address(
        &[
            Received::SEED_PREFIX,
            &emitter_chain.to_le_bytes(),
            &sequence.to_le_bytes(),
        ],
        program_id,
    );

    // Build the receive_greeting instruction
    // Use RESOLVER_PUBKEY_POSTED_VAA placeholder - Executor will:
    // 1. Post the VAA to Wormhole Core Bridge
    // 2. Replace placeholder with actual posted_vaa account address
    let receive_data = crate::instruction::ReceiveGreeting { vaa_hash }.data();

    let instruction = SerializableInstruction {
        program_id: *program_id,
        accounts: vec![
            SerializableAccountMeta {
                pubkey: RESOLVER_PUBKEY_PAYER,
                is_signer: true,
                is_writable: true,
            },
            SerializableAccountMeta {
                pubkey: *config_key,
                is_signer: false,
                is_writable: false,
            },
            SerializableAccountMeta {
                pubkey: *wormhole_program_key,
                is_signer: false,
                is_writable: false,
            },
            SerializableAccountMeta {
                // Use placeholder - Executor will post VAA and replace with actual address
                pubkey: RESOLVER_PUBKEY_POSTED_VAA,
                is_signer: false,
                is_writable: false,
            },
            SerializableAccountMeta {
                pubkey: peer,
                is_signer: false,
                is_writable: false,
            },
            SerializableAccountMeta {
                pubkey: received,
                is_signer: false,
                is_writable: true,
            },
            SerializableAccountMeta {
                pubkey: *system_program_key,
                is_signer: false,
                is_writable: false,
            },
        ],
        data: receive_data,
    };

    Ok(Resolver::Resolved(InstructionGroups(vec![InstructionGroup {
        instructions: vec![instruction],
        address_lookup_tables: vec![],
    }])))
}
