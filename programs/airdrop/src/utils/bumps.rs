use anchor_lang::prelude::*;
use crate::{constants::*};

/// Generate signer seeds for a project PDA
/// 
/// Returns the bump seed. The caller should construct the seeds array with proper lifetimes.
pub fn get_project_bump(
    project_nonce: u64,
    program_id: &Pubkey,
) -> u8 {
    let project_nonce_bytes = project_nonce.to_le_bytes();
    let (_, project_bump) = Pubkey::find_program_address(
        &[
            PROJECT_SEED_PREFIX,
            project_nonce_bytes.as_ref(),
        ],
        program_id,
    );
    
    project_bump
}