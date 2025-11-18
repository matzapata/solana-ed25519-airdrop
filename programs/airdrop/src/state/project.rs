use anchor_lang::prelude::*;

/// The Project account that holds SPL tokens for distribution
#[account]
#[derive(InitSpace)]
pub struct Project {
    /// The nonce used as a seed for the PDA
    pub nonce: u64,
    
    /// The mint of the SPL token being distributed
    pub mint: Pubkey,

    /// The authority that can manage this project
    pub authority: Pubkey,
}
