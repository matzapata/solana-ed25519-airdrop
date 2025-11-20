use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::Instruction,
    pubkey::Pubkey,
    sysvar::instructions as ix_sysvar,
};
use solana_program::ed25519_program;
use crate::errors::AirdropError;

/// Constants for parsing Ed25519 instruction data
pub const MIN_HEADER_LEN: usize = 2;  // minimum header: 1 byte count + 1 byte padding
pub const SIG_ENTRY_LEN: usize = 14;  // 7 u16 values per signature entry (14 bytes)
pub const PUBKEY_LEN: usize = 32;     // size of an Ed25519 public key
pub const SIG_LEN: usize = 64;        // size of an Ed25519 signature

/// Parsed Ed25519 signature data
#[derive(Debug, Clone)]
pub struct Ed25519SignatureOffsets {
    pub signature_offset: usize,
    pub signature_instruction_index: u16,
    pub public_key_offset: usize,
    pub public_key_instruction_index: u16,
    pub message_data_offset: usize,
    pub message_data_size: usize,
    pub message_instruction_index: u16,
}

/// Validates that the instruction at the given index is an Ed25519 signature verification instruction
/// that immediately precedes the current instruction.
pub fn validate_ed25519_ix(
    ix_sysvar_account: &AccountInfo,
    current_ix_index: usize,
) -> Result<Instruction> {
    // The Ed25519 verification must have run just before this instruction
    require!(current_ix_index > 0, AirdropError::InvalidInstructionSysvar);

    // Load the immediately preceding instruction (the Ed25519 ix)
    let ed_ix = ix_sysvar::load_instruction_at_checked(
        current_ix_index - 1,
        ix_sysvar_account,
    )
    .map_err(|_| error!(AirdropError::InvalidInstructionSysvar))?;

    // Ensure it is the Ed25519 program and uses no accounts (stateless check)
    require!(
        ed_ix.program_id == ed25519_program::id(),
        AirdropError::BadEd25519Program
    );
    require!(ed_ix.accounts.is_empty(), AirdropError::BadEd25519Accounts);

    Ok(ed_ix)
}

/// Parses the Ed25519 instruction data format to extract offsets for all signatures
pub fn parse_ed25519_ix_data(data: &[u8]) -> Result<Vec<Ed25519SignatureOffsets>> {
    // Verify minimum length (at least count byte + padding + one signature entry)
    require!(
        data.len() >= MIN_HEADER_LEN + SIG_ENTRY_LEN,
        AirdropError::InvalidInstructionSysvar
    );

    // First byte: number of signatures
    let sig_count = data[0] as usize;
    require!(sig_count > 0, AirdropError::InvalidInstructionSysvar);
    require!(sig_count <= 255, AirdropError::InvalidInstructionSysvar);

    // Calculate minimum header length: 2 bytes (count + padding) + 14 bytes per signature
    let min_header_len = MIN_HEADER_LEN + (sig_count * SIG_ENTRY_LEN);
    require!(
        data.len() >= min_header_len,
        AirdropError::InvalidInstructionSysvar
    );

    // Helper to read u16 offsets (little-endian)
    let read_u16 = |offset: usize| -> Result<u16> {
        let end = offset + 2;
        let src = data
            .get(offset..end)
            .ok_or(error!(AirdropError::InvalidInstructionSysvar))?;
        let mut arr = [0u8; 2];
        arr.copy_from_slice(src);
        Ok(u16::from_le_bytes(arr))
    };

    let mut offsets_vec = Vec::with_capacity(sig_count);
    let this_ix = u16::MAX; // Sentinel value for "current instruction"

    // Parse each signature entry
    for i in 0..sig_count {
        let base_offset = MIN_HEADER_LEN + (i * SIG_ENTRY_LEN);
        
        // Read the 7 u16 values for this signature
        let signature_offset = read_u16(base_offset)? as usize;
        let signature_instruction_index = read_u16(base_offset + 2)?;
        let public_key_offset = read_u16(base_offset + 4)? as usize;
        let public_key_instruction_index = read_u16(base_offset + 6)?;
        let message_data_offset = read_u16(base_offset + 8)? as usize;
        let message_data_size = read_u16(base_offset + 10)? as usize;
        let message_instruction_index = read_u16(base_offset + 12)?;

        // Enforce that all offsets point to the current instruction's data
        require!(
            signature_instruction_index == this_ix
                && public_key_instruction_index == this_ix
                && message_instruction_index == this_ix,
            AirdropError::InvalidInstructionSysvar
        );

        // Ensure all offsets point beyond the header
        require!(
            signature_offset >= min_header_len
                && public_key_offset >= min_header_len
                && message_data_offset >= min_header_len,
            AirdropError::InvalidInstructionSysvar
        );

        // Bounds checks for signature, pubkey, and message slices
        require!(
            data.len() >= signature_offset + SIG_LEN,
            AirdropError::InvalidInstructionSysvar
        );
        require!(
            data.len() >= public_key_offset + PUBKEY_LEN,
            AirdropError::InvalidInstructionSysvar
        );
        require!(
            data.len() >= message_data_offset + message_data_size,
            AirdropError::InvalidInstructionSysvar
        );

        offsets_vec.push(Ed25519SignatureOffsets {
            signature_offset,
            signature_instruction_index,
            public_key_offset,
            public_key_instruction_index,
            message_data_offset,
            message_data_size,
            message_instruction_index,
        });
    }

    Ok(offsets_vec)
}

/// Extracts the public key from Ed25519 instruction data at the specified offset
pub fn extract_signer_pubkey(data: &[u8], offsets: &Ed25519SignatureOffsets) -> Result<Pubkey> {
    let pk_slice = &data[offsets.public_key_offset..offsets.public_key_offset + PUBKEY_LEN];
    let mut pk_arr = [0u8; 32];
    pk_arr.copy_from_slice(pk_slice);
    Ok(Pubkey::new_from_array(pk_arr))
}

/// Extracts the message data from Ed25519 instruction data at the specified offset
pub fn extract_signed_message<'a>(data: &'a [u8], offsets: &Ed25519SignatureOffsets) -> &'a [u8] {
    &data[offsets.message_data_offset..offsets.message_data_offset + offsets.message_data_size]
}

/// Validates and parses Ed25519 signatures, returning the message and all signers
/// All signatures are already verified by the Ed25519 program and sign the same message
pub fn verify_ed25519_signature(
    ix_sysvar_account: &AccountInfo,
) -> Result<(Vec<Pubkey>, Vec<u8>)> {
    // Get current instruction index
    let current_ix_index = ix_sysvar::load_current_index_checked(ix_sysvar_account)
        .map_err(|_| error!(AirdropError::InvalidInstructionSysvar))?;

    // Validate that the previous instruction is an Ed25519 verification
    let ed_ix = validate_ed25519_ix(ix_sysvar_account, current_ix_index as usize)?;

    // Parse the Ed25519 instruction data (may contain multiple signatures)
    let offsets_vec = parse_ed25519_ix_data(&ed_ix.data)?;
    require!(!offsets_vec.is_empty(), AirdropError::InvalidInstructionSysvar);

    // Extract the message from the first signature (all signatures sign the same message)
    let message = extract_signed_message(&ed_ix.data, &offsets_vec[0]).to_vec();

    // Extract all public keys (signers)
    let mut signers = Vec::with_capacity(offsets_vec.len());
    for offsets in offsets_vec.iter() {
        let pubkey = extract_signer_pubkey(&ed_ix.data, offsets)?;
        signers.push(pubkey);
    }

    Ok((signers, message))
}

