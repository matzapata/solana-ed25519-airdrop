use crate::errors::*;
use anchor_lang::prelude::*;
use borsh::BorshDeserialize;

/// Generic domain fields for all signed messages
#[derive(BorshDeserialize, Clone)]
pub struct MessageDomain {
    pub program_id: Pubkey,
    pub version: u8,
    pub nonce: u64,
    pub deadline: i64,
}

/// Generic validation function for signed messages
pub fn validate_message_domain(domain: &MessageDomain, nonce: u64) -> Result<()> {
    // Validate the program_id matches
    require!(
        domain.program_id == crate::ID,
        AirdropError::ProgramIdMismatch
    );

    // Validate the version matches (currently version 1)
    require!(domain.version == 1, AirdropError::VersionMismatch);

    // Validate the deadline hasn't expired
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp <= domain.deadline,
        AirdropError::DeadlineExpired
    );

    // Validate the nonce matches the instruction nonce
    require!(
        domain.nonce == nonce,
        AirdropError::NonceMismatch
    );

    Ok(())
}