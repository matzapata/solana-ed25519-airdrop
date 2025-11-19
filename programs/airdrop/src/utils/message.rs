use crate::{constants::*, errors::*};
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

/// Validates the generic domain fields of a signed message.
///
/// Ensures:
/// - The message was intended for this program (program_id matches crate::ID)
/// - The message version matches the expected version
/// - The current unix timestamp has not passed the message deadline
/// - The message nonce matches the expected nonce
///
/// # Arguments
/// * `domain` - The generic message domain fields to validate
/// * `nonce`  - The expected nonce for the current instruction used to derive the nullifier PDA
pub fn validate_message_domain(domain: &MessageDomain, nonce: u64) -> Result<()> {
    // Validate the program_id matches
    require!(
        domain.program_id == crate::ID,
        AirdropError::ProgramIdMismatch
    );

    // Validate the version matches 
    require!(domain.version == VERSION, AirdropError::VersionMismatch);

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