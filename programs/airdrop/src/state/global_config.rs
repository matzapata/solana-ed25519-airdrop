use anchor_lang::prelude::*;

/// Global configuration for the airdrop program
#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    /// The authority that can update the configuration
    pub authority: Pubkey,
    
    /// The expected distributor public key (for Ed25519 signature verification)
    pub distributor: Pubkey,
}

