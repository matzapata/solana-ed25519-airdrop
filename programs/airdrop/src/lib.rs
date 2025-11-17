use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;

use instructions::*;

declare_id!("H3eYcELNCrf1iTxVukbkfxu1uzuzSbgeZqjAPjhZWQbe");

#[program]
pub mod airdrop {
    use super::*;

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        ctx.accounts.claim()
    }
}
