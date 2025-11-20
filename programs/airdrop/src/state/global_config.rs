use anchor_lang::prelude::*;

/// Global configuration for the airdrop program
#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    /// The authority that can update the configuration
    pub authority: Pubkey,
    
    /// The expected distributor public keys (all must sign for Ed25519 signature verification)
    #[max_len(10)]
    pub distributors: Vec<Pubkey>,
}

