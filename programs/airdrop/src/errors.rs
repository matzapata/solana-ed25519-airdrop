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
    #[msg("Failed to deserialize message")]
    InvalidMessage,
    #[msg("Signature deadline has expired")]
    DeadlineExpired,
    #[msg("Project nonce mismatch")]
    ProjectMismatch,
    #[msg("Mint mismatch")]
    MintMismatch,
    #[msg("Nonce mismatch - signature replay attack detected")]
    NonceMismatch,
    #[msg("Program ID mismatch")]
    ProgramIdMismatch,
    #[msg("Version mismatch")]
    VersionMismatch,
}
