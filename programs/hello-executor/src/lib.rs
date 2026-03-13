use anchor_lang::prelude::*;

pub use error::*;
pub use instructions::*;
pub use message::*;
pub use resolver::*;
pub use state::*;

pub mod error;
pub mod executor_cpi;
pub mod instructions;
pub mod message;
pub mod resolver;
pub mod state;

// TODO(redeploy): Update this ID when redeploying with a new keypair.
// Run: solana-keygen pubkey target/deploy/hello_executor-keypair.json
// Then update this value AND the matching [programs.<network>] entry in Anchor.toml
// (e.g. [programs.devnet] for Devnet, [programs.mainnet] for Mainnet).
declare_id!("7eiTqf1b1dNwpzn27qEr4eGSWnuon2fJTbnTuWcFifZG");

#[program]
/// # Hello Executor
///
/// A cross-chain Hello World application using Wormhole's Executor service
/// for automatic message relay across chains.
pub mod hello_executor {
    use super::*;

    /// Initialize the program config and create the Wormhole emitter.
    pub fn initialize(ctx: Context<Initialize>, chain_id: u16) -> Result<()> {
        instructions::initialize::handler(ctx, chain_id)
    }

    /// Register a peer contract on another chain.
    pub fn register_peer(
        ctx: Context<RegisterPeer>,
        chain: u16,
        address: [u8; 32],
    ) -> Result<()> {
        instructions::register_peer::handler(ctx, chain, address)
    }

    /// Send a cross-chain greeting message.
    pub fn send_greeting(ctx: Context<SendGreeting>, greeting: String) -> Result<()> {
        instructions::send_greeting::handler(ctx, greeting)
    }

    /// Receive and process a cross-chain greeting.
    pub fn receive_greeting(ctx: Context<ReceiveGreeting>, vaa_hash: [u8; 32]) -> Result<()> {
        instructions::receive_greeting::handler(ctx, vaa_hash)
    }

    /// Request Executor relay for the most recently posted message.
    pub fn request_relay(ctx: Context<RequestRelay>, args: RequestRelayArgs) -> Result<()> {
        instructions::request_relay::handler(ctx, args)
    }

    /// Update Wormhole configuration (owner only).
    pub fn update_wormhole_config(ctx: Context<UpdateWormholeConfig>) -> Result<()> {
        instructions::update_config::handler(ctx)
    }

    /// Executor VAA resolver — Anchor-callable path (for testing / direct calls).
    ///
    /// ## Two resolver paths — read this before calling
    ///
    /// The Wormhole Executor calls this program's resolver using its own
    /// discriminator (`94b8a9decf089a7f`, see `fallback` below), **not** through
    /// the Anchor-generated discriminator of this instruction.  The two paths
    /// are functionally equivalent and share the same `build_resolver_result` logic:
    ///
    /// | Caller           | Entry point       | Discriminator     | Accounts passed? |
    /// |------------------|-------------------|-------------------|-----------------|
    /// | Wormhole Executor | `fallback`        | `94b8a9decf089a7f`| No — derived    |
    /// | Test / manual     | this instruction  | Anchor-generated  | Yes             |
    ///
    /// If you are **integrating with the Executor service**, you do not call this
    /// instruction directly — the Executor discovers and calls the resolver
    /// automatically via the fallback handler.
    ///
    /// If you are **writing tests** against the resolver, you can call this
    /// instruction with an `ExecuteVaaV1` context to inspect the returned
    /// `InstructionGroups` without needing the Executor service.
    pub fn resolve_execute_vaa_v1(
        ctx: Context<ExecuteVaaV1>,
        vaa_body: Vec<u8>,
    ) -> Result<resolver::ResolverType<resolver::ResolverInstructionGroups>> {
        resolver::handle_resolve(ctx, vaa_body)
    }

    /// Fallback instruction handler — routes the Executor's custom discriminator
    /// to the VAA resolver.
    ///
    /// The Wormhole Executor calls programs using discriminator
    /// `[148, 184, 169, 222, 207, 8, 154, 127]` (`94b8a9decf089a7f`), which
    /// does not match Anchor's auto-generated discriminator for any named
    /// instruction. This fallback intercepts that call, parses the raw VAA bytes
    /// from the instruction data, derives all required PDAs internally (the
    /// Executor passes no accounts), and uses `set_return_data` to return the
    /// `InstructionGroups` telling the Executor which instruction to execute.
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        // Anchor 0.31+ with `interface-instructions` feature would allow replacing this
        // fallback with `#[instruction(discriminator = &RESOLVER_EXECUTE_VAA_V1)]` on the
        // named instruction, but that requires upgrading solana-program to 2.x (out of scope).
        use executor_account_resolver_svm::RESOLVER_EXECUTE_VAA_V1;

        if data.len() >= 8 && data[..8] == RESOLVER_EXECUTE_VAA_V1 {
            msg!("Executor resolver call detected");
            return resolver::handle_resolve_raw(program_id, accounts, &data[8..]);
        }

        Err(anchor_lang::error::ErrorCode::InstructionFallbackNotFound.into())
    }
}
