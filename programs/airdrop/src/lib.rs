use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;
pub mod utils;
pub mod constants;

use instructions::*;

declare_id!("H3eYcELNCrf1iTxVukbkfxu1uzuzSbgeZqjAPjhZWQbe");

#[program]
pub mod airdrop {
    use super::*;

    pub fn create_global_config(ctx: Context<CreateGlobalConfig>, distributors: Vec<Pubkey>) -> Result<()> {
        ctx.accounts.create(distributors)
    }

    pub fn create_project(ctx: Context<CreateProject>, nonce: u64) -> Result<()> {
        ctx.accounts.create_project(nonce)
    }

    pub fn claim(ctx: Context<Claim>, project_nonce: u64, nonce: u64) -> Result<()> {
        ctx.accounts.claim(project_nonce, nonce)
    }
}
