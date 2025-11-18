use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program_error::ProgramError, system_instruction};
use anchor_spl::token::{self, Transfer};

pub fn transfer_native<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
    signer: Option<&[&[&[u8]]]>,
) -> Result<()> {
    // Check if we're transferring from an account with data (PDA)
    if !from.data_is_empty() {
        // For PDAs with data, we must manually adjust lamports
        // This is the only way to transfer SOL from a PDA that owns data
        **from.try_borrow_mut_lamports()? = from
            .lamports()
            .checked_sub(amount)
            .ok_or(ProgramError::InsufficientFunds)?;
        
        **to.try_borrow_mut_lamports()? = to
            .lamports()
            .checked_add(amount)
            .ok_or(ProgramError::InvalidArgument)?;
    } else {
        // For regular accounts without data, use system_instruction::transfer
        let transfer_ix = system_instruction::transfer(&from.key(), &to.key(), amount);
        
        if let Some(signer_seeds) = signer {
            anchor_lang::solana_program::program::invoke_signed(
                &transfer_ix,
                &[from.to_account_info(), to.to_account_info()],
                signer_seeds,
            )?;
        } else {
            anchor_lang::solana_program::program::invoke(
                &transfer_ix,
                &[from.to_account_info(), to.to_account_info()],
            )?;
        }
    }
    
    Ok(())
}

pub fn transfer_spl<'info>(
    token_program: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    amount: u64,
    signer: Option<&[&[&[u8]]]>,
) -> Result<()> {
    let cpi_accounts = Transfer {
        from: from.to_account_info(),
        to: to.to_account_info(),
        authority,
    };

    let cpi_ctx = if let Some(signer) = signer {
        CpiContext::new_with_signer(token_program, cpi_accounts, signer)
    } else {
        CpiContext::new(token_program, cpi_accounts)
    };

    token::transfer(cpi_ctx, amount)?;

    Ok(())
}
