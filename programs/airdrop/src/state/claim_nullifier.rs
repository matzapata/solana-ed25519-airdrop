use anchor_lang::prelude::*;

/// Nullifier account to track used nonces and prevent signature replay attacks
#[account]
#[derive(InitSpace)]
pub struct ClaimNullifier {
    /// The nonce that has been used
    pub nonce: u64
}

