use crate::{constants::*, state::*};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CreateGlobalConfig<'info> {
    /// The authority that can manage the configuration
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The global config PDA
    #[account(
        init,
        payer = authority,
        space = GlobalConfig::DISCRIMINATOR.len() + GlobalConfig::INIT_SPACE,
        seeds = [GLOBAL_CONFIG_SEED],
        bump
    )]
    pub global_config: Account<'info, GlobalConfig>,

    pub system_program: Program<'info, System>,
}

impl<'info> CreateGlobalConfig<'info> {
    pub fn create(&mut self, distributor: Pubkey) -> Result<()> {
        self.global_config.set_inner(GlobalConfig {
            authority: self.authority.key(),
            distributor,
        });

        Ok(())
    }
}

