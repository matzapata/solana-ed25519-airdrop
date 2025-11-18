use anchor_lang::prelude::*;

/// Nullifier account to track used nonces and prevent signature replay attacks
#[account]
#[derive(InitSpace)]
pub struct ClaimNullifier {
    /// The nonce that has been used
    pub nonce: u64,
    /// The project this nullifier belongs to
    pub project: Pubkey,
    /// The recipient who claimed with this nonce
    pub recipient: Pubkey,
    /// Timestamp when the nonce was used
    pub used_at: i64,
}

