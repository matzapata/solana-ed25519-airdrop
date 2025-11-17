use anchor_lang::prelude::*;

#[error_code]
pub enum AirdropError {
    #[msg("Invalid instruction sysvar")]
    InvalidInstructionSysvar,
    #[msg("Expected Ed25519 program id")]
    BadEd25519Program,
    #[msg("Bad Ed25519 accounts")]
    BadEd25519Accounts,
    #[msg("Distributor public key mismatch")]
    DistributorMismatch,
    #[msg("Recipient mismatch in message")]
    RecipientMismatch,
}
