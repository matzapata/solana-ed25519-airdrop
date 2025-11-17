use anchor_lang::prelude::*;

declare_id!("H3eYcELNCrf1iTxVukbkfxu1uzuzSbgeZqjAPjhZWQbe");

#[program]
pub mod verify_ed25519 {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
