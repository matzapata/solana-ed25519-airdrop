use crate::errors::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{sysvar::instructions as ix_sysvar, sysvar::SysvarId};

/// Trait for messages that can be validated generically
pub trait SignedMessage {
    /// Get the program ID from the message
    fn program_id(&self) -> Pubkey;

    /// Get the version from the message
    fn version(&self) -> u8;

    /// Get the deadline from the message
    fn deadline(&self) -> i64;
}

/// Generic validation function for signed messages
pub fn validate_signed_message<T: SignedMessage>(msg: &T) -> Result<()> {
    // Validate the program_id matches
    require!(
        msg.program_id() == crate::ID,
        AirdropError::ProgramIdMismatch
    );

    // Validate the version matches (currently version 1)
    require!(msg.version() == 1, AirdropError::VersionMismatch);

    // Validate the deadline hasn't expired
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp <= msg.deadline(),
        AirdropError::DeadlineExpired
    );

    Ok(())
}