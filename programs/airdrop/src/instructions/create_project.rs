use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};
use crate::constants::*;
use crate::state::*;

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateProject<'info> {
    /// The authority that will manage this project
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The project PDA account to be created
    #[account(
        init,
        payer = authority,
        space = Project::DISCRIMINATOR.len() + Project::INIT_SPACE,
        seeds = [PROJECT_SEED_PREFIX, nonce.to_le_bytes().as_ref()],
        bump
    )]
    pub project: Account<'info, Project>,

    /// The mint of the SPL token to be distributed
    pub mint: Account<'info, Mint>,

    /// The token account owned by the project PDA
    #[account(
        init,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = project
    )]
    pub project_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> CreateProject<'info> {
    pub fn create_project(&mut self, nonce: u64) -> Result<()> {
        self.project.set_inner(Project {
            nonce,
            mint: self.mint.key(),
            authority: self.authority.key(),
        });

        Ok(())
    }
}

