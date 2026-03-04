use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke;
use std::str::FromStr;

#[derive(Clone)]
pub struct ExecutorProgram;

impl Id for ExecutorProgram {
    fn id() -> Pubkey {
        Pubkey::from_str("execXUrAsMnqMmTHj5m7N1YQgsDz3cwGLYCYyuDRciV")
            .expect("invalid executor program id")
    }
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RequestForExecutionArgs {
    pub amount: u64,
    pub dst_chain: u16,
    pub dst_addr: [u8; 32],
    pub refund_addr: Pubkey,
    pub signed_quote_bytes: Vec<u8>,
    pub request_bytes: Vec<u8>,
    pub relay_instructions: Vec<u8>,
}

pub fn request_for_execution<'info>(
    executor_program: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    payee: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    args: RequestForExecutionArgs,
) -> Result<()> {
    // Discriminator from executor.json IDL
    const DISCRIMINATOR: [u8; 8] = [109, 107, 87, 37, 151, 192, 119, 115];

    let mut data = Vec::with_capacity(8 + args.try_to_vec()?.len());
    data.extend_from_slice(&DISCRIMINATOR);
    data.extend_from_slice(&args.try_to_vec()?);

    let ix = Instruction {
        program_id: *executor_program.key,
        accounts: vec![
            AccountMeta::new(*payer.key, true),
            AccountMeta::new(*payee.key, false),
            AccountMeta::new_readonly(*system_program.key, false),
        ],
        data,
    };

    invoke(
        &ix,
        &[
            payer.clone(),
            payee.clone(),
            system_program.clone(),
        ],
    )?;

    Ok(())
}
