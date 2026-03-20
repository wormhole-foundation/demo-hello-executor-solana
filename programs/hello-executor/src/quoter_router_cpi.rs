use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use std::str::FromStr;

// ============================================================================
// Program IDs
// ============================================================================

/// Executor Quoter Router program on Solana devnet.
#[derive(Clone)]
pub struct QuoterRouterProgram;

pub const QUOTER_ROUTER_PROGRAM_ID: &str = "qtrrrV7W3E1jnX1145wXR6ZpthG19ur5xHC1n6PPhDV";
pub const QUOTER_PROGRAM_ID: &str = "qtrxiqVAfVS61utwZLUi7UKugjCgFaNxBGyskmGingz";

impl Id for QuoterRouterProgram {
    fn id() -> Pubkey {
        Pubkey::from_str(QUOTER_ROUTER_PROGRAM_ID).expect("invalid quoter router program id")
    }
}

/// Executor Quoter program on Solana devnet.
#[derive(Clone)]
pub struct QuoterProgram;

impl Id for QuoterProgram {
    fn id() -> Pubkey {
        Pubkey::from_str(QUOTER_PROGRAM_ID).expect("invalid quoter program id")
    }
}

// ============================================================================
// Constants
// ============================================================================

/// Default quoter EVM address (20 bytes).
/// Corresponds to `0x5241C9276698439fEf2780DbaB76fEc90B633Fbd`.
pub const DEFAULT_QUOTER_EVM_ADDRESS: [u8; 20] = [
    0x52, 0x41, 0xC9, 0x27, 0x66, 0x98, 0x43, 0x9f, 0xeF, 0x27, 0x80, 0xDb, 0xaB, 0x76, 0xfE, 0xc9,
    0x0B, 0x63, 0x3F, 0xbd,
];

/// Derive the QuoterRegistration PDA on the router program.
/// Seeds: `["quoter_registration", quoter_evm_addr_20bytes]`
pub fn derive_quoter_registration(
    router_program: &Pubkey,
    quoter_evm_addr: &[u8; 20],
) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"quoter_registration", quoter_evm_addr], router_program)
}

/// Derive the ChainInfo PDA on the quoter program.
/// Seeds: `["chain_info", dst_chain_u16_le]`
pub fn derive_chain_info(quoter_program: &Pubkey, dst_chain: u16) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"chain_info", &dst_chain.to_le_bytes()], quoter_program)
}

/// Derive the QuoteBody PDA on the quoter program.
/// Seeds: `["quote", dst_chain_u16_le]`
pub fn derive_quote_body(quoter_program: &Pubkey, dst_chain: u16) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"quote", &dst_chain.to_le_bytes()], quoter_program)
}

/// Derive the Config PDA on the router or quoter program.
pub fn derive_config(program: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"config"], program)
}

/// Derive the event authority PDA on the quoter program.
pub fn derive_event_authority(quoter_program: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"__event_authority"], quoter_program)
}

// ============================================================================
// CPI
// ============================================================================

/// Build and invoke the RequestExecution instruction on the quoter router.
///
/// Account layout and data format from the router source:
/// https://github.com/wormholelabs-xyz/example-messaging-executor/blob/main/svm/pinocchio/programs/executor-quoter-router/src/instructions/request_execution.rs
///
/// The router dispatches to the quoter which gets a price, then CPIs to the
/// executor to register the relay and collect payment.
///
/// ## Router instruction data format
///
/// ```text
/// [2]                                 — router discriminator (1 byte)
/// [amount: u64 LE]                    — payment amount (8 bytes)
/// [quoter_address: [u8; 20]]          — quoter EVM address (20 bytes)
/// [3, 0, 0, 0, 0, 0, 0, 0]           — quoter discriminator (8 bytes)
/// [dst_chain: u16 LE]                 — destination chain (2 bytes)
/// [dst_addr: [u8; 32]]               — destination address (32 bytes)
/// [refund_addr: [u8; 32]]            — refund address (32 bytes)
/// [request_bytes_len: u32 LE][data…]  — ERV1 request (length-prefixed)
/// [relay_instr_len: u32 LE][data…]    — relay instructions (length-prefixed)
/// ```
///
/// ## Router accounts (12)
///
/// ```text
/// 0. payer           [signer, writable]
/// 1. _config         []  (placeholder, unused by router)
/// 2. quoterReg       []  (PDA on router)
/// 3. quoterProgram   []
/// 4. executorProg    []
/// 5. payee           [writable]
/// 6. refundAddr      [writable]  (= payer)
/// 7. systemProgram   []
/// 8. quoterConfig    []  (forwarded to quoter)
/// 9. chainInfo       []  (forwarded to quoter)
/// 10. quoteBody      []  (forwarded to quoter)
/// 11. eventCpi       []  (forwarded to quoter)
/// ```
#[allow(clippy::too_many_arguments)]
pub fn build_request_execution_on_chain_quote_ix(
    // Programs
    quoter_router_program: &Pubkey,
    quoter_program: &Pubkey,
    executor_program: &Pubkey,
    // Accounts
    payer: &Pubkey,
    router_config: &Pubkey,
    quoter_registration: &Pubkey,
    payee: &Pubkey,
    system_program: &Pubkey,
    quoter_config: &Pubkey,
    chain_info: &Pubkey,
    quote_body: &Pubkey,
    event_cpi: &Pubkey,
    // Data
    amount: u64,
    quoter_address: &[u8; 20],
    dst_chain: u16,
    dst_addr: &[u8; 32],
    refund_addr: &Pubkey,
    request_bytes: &[u8],
    relay_instructions: &[u8],
) -> Instruction {
    // Quoter discriminator (cpiData prefix passed to the quoter program)
    const QUOTER_DISCRIMINATOR: [u8; 8] = [3, 0, 0, 0, 0, 0, 0, 0];

    let data_len =
        1 + 8 + 20 + 8 + 2 + 32 + 32 + 4 + request_bytes.len() + 4 + relay_instructions.len();
    let mut data = Vec::with_capacity(data_len);

    // Router discriminator
    data.push(2u8);
    // Amount (u64 LE)
    data.extend_from_slice(&amount.to_le_bytes());
    // Quoter EVM address (20 bytes)
    data.extend_from_slice(quoter_address);
    // Quoter discriminator (cpiData prefix for quoter)
    data.extend_from_slice(&QUOTER_DISCRIMINATOR);
    // Destination chain (u16 LE)
    data.extend_from_slice(&dst_chain.to_le_bytes());
    // Destination address (32 bytes)
    data.extend_from_slice(dst_addr);
    // Refund address (32 bytes)
    data.extend_from_slice(&refund_addr.to_bytes());
    // Request bytes (length-prefixed)
    data.extend_from_slice(&(request_bytes.len() as u32).to_le_bytes());
    data.extend_from_slice(request_bytes);
    // Relay instructions (length-prefixed)
    data.extend_from_slice(&(relay_instructions.len() as u32).to_le_bytes());
    data.extend_from_slice(relay_instructions);

    Instruction {
        program_id: *quoter_router_program,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(*router_config, false),
            AccountMeta::new_readonly(*quoter_registration, false),
            AccountMeta::new_readonly(*quoter_program, false),
            AccountMeta::new_readonly(*executor_program, false),
            AccountMeta::new(*payee, false),
            AccountMeta::new(*payer, false),
            AccountMeta::new_readonly(*system_program, false),
            AccountMeta::new_readonly(*quoter_config, false),
            AccountMeta::new_readonly(*chain_info, false),
            AccountMeta::new_readonly(*quote_body, false),
            AccountMeta::new_readonly(*event_cpi, false),
        ],
        data,
    }
}

#[allow(clippy::too_many_arguments)]
pub fn request_execution_on_chain_quote<'info>(
    // Programs
    quoter_router_program: &AccountInfo<'info>,
    quoter_program: &AccountInfo<'info>,
    executor_program: &AccountInfo<'info>,
    // Accounts
    payer: &AccountInfo<'info>,
    router_config: &AccountInfo<'info>,
    quoter_registration: &AccountInfo<'info>,
    payee: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    quoter_config: &AccountInfo<'info>,
    chain_info: &AccountInfo<'info>,
    quote_body: &AccountInfo<'info>,
    event_cpi: &AccountInfo<'info>,
    // Data
    amount: u64,
    quoter_address: &[u8; 20],
    dst_chain: u16,
    dst_addr: &[u8; 32],
    refund_addr: &Pubkey,
    request_bytes: &[u8],
    relay_instructions: &[u8],
) -> Result<()> {
    let ix = build_request_execution_on_chain_quote_ix(
        quoter_router_program.key,
        quoter_program.key,
        executor_program.key,
        payer.key,
        router_config.key,
        quoter_registration.key,
        payee.key,
        system_program.key,
        quoter_config.key,
        chain_info.key,
        quote_body.key,
        event_cpi.key,
        amount,
        quoter_address,
        dst_chain,
        dst_addr,
        refund_addr,
        request_bytes,
        relay_instructions,
    );

    invoke(
        &ix,
        &[
            payer.clone(),
            router_config.clone(),
            quoter_registration.clone(),
            quoter_program.clone(),
            executor_program.clone(),
            payee.clone(),
            payer.clone(), // refund = payer
            system_program.clone(),
            quoter_config.clone(),
            chain_info.clone(),
            quote_body.clone(),
            event_cpi.clone(),
        ],
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_expected_request_execution_instruction() {
        let payer = Pubkey::new_unique();
        let router_config = Pubkey::new_unique();
        let quoter_registration = Pubkey::new_unique();
        let payee = Pubkey::new_unique();
        let system_program = anchor_lang::solana_program::system_program::ID;
        let quoter_config = Pubkey::new_unique();
        let chain_info = Pubkey::new_unique();
        let quote_body = Pubkey::new_unique();
        let event_cpi = Pubkey::new_unique();
        let executor_program = Pubkey::new_unique();

        let request_bytes = b"ERV1payload";
        let relay_instructions = b"relay";
        let dst_addr = [9u8; 32];
        let refund_addr = Pubkey::new_unique();

        let ix = build_request_execution_on_chain_quote_ix(
            &QuoterRouterProgram::id(),
            &QuoterProgram::id(),
            &executor_program,
            &payer,
            &router_config,
            &quoter_registration,
            &payee,
            &system_program,
            &quoter_config,
            &chain_info,
            &quote_body,
            &event_cpi,
            42,
            &DEFAULT_QUOTER_EVM_ADDRESS,
            10002,
            &dst_addr,
            &refund_addr,
            request_bytes,
            relay_instructions,
        );

        assert_eq!(ix.program_id, QuoterRouterProgram::id());
        assert_eq!(ix.accounts.len(), 12);
        assert_eq!(ix.accounts[0], AccountMeta::new(payer, true));
        assert_eq!(ix.accounts[5], AccountMeta::new(payee, false));
        assert_eq!(ix.accounts[6], AccountMeta::new(payer, false));
        assert_eq!(ix.accounts[11], AccountMeta::new_readonly(event_cpi, false));

        let mut expected = vec![2u8];
        expected.extend_from_slice(&42u64.to_le_bytes());
        expected.extend_from_slice(&DEFAULT_QUOTER_EVM_ADDRESS);
        expected.extend_from_slice(&[3, 0, 0, 0, 0, 0, 0, 0]);
        expected.extend_from_slice(&10002u16.to_le_bytes());
        expected.extend_from_slice(&dst_addr);
        expected.extend_from_slice(&refund_addr.to_bytes());
        expected.extend_from_slice(&(request_bytes.len() as u32).to_le_bytes());
        expected.extend_from_slice(request_bytes);
        expected.extend_from_slice(&(relay_instructions.len() as u32).to_le_bytes());
        expected.extend_from_slice(relay_instructions);

        assert_eq!(ix.data, expected);
    }
}
