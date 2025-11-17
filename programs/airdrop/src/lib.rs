use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    pubkey::Pubkey,
    sysvar::instructions as ix_sysvar,
    sysvar::SysvarId
};
use solana_program::ed25519_program;


declare_id!("H3eYcELNCrf1iTxVukbkfxu1uzuzSbgeZqjAPjhZWQbe");

#[program]
pub mod airdrop {
    use super::*;

    pub fn claim(ctx: Context<Claim>) -> Result<()> {

        // --- constants for parsing Ed25519 instruction data ---
        const HEADER_LEN: usize = 16;  // fixed-size instruction header
        const PUBKEY_LEN: usize = 32;  // size of an Ed25519 public key
        const SIG_LEN: usize = 64;     // size of an Ed25519 signature
        const MSG_LEN: usize = 40;     // expected message length: [recipient(32) + amount(8)]

        // Load the instruction sysvar account (holds all tx instructions)
        let ix_sysvar_account = ctx.accounts.instruction_sysvar.to_account_info();

        // Index of the current instruction in the transaction
        let current_ix_index = ix_sysvar::load_current_index_checked(&ix_sysvar_account)
            .map_err(|_| error!(AirdropError::InvalidInstructionSysvar))?;

        // The Ed25519 verification must have run just before this instruction
        require!(current_ix_index > 0, AirdropError::InvalidInstructionSysvar);

        // Load the immediately preceding instruction (the Ed25519 ix)
        let ed_ix = ix_sysvar::load_instruction_at_checked(
            (current_ix_index - 1) as usize,
            &ix_sysvar_account,
        )
        .map_err(|_| error!(AirdropError::InvalidInstructionSysvar))?;

        // Ensure it is the Ed25519 program and uses no accounts (stateless check)
        require!(ed_ix.program_id == ed25519_program::id(), AirdropError::BadEd25519Program);
        require!(ed_ix.accounts.is_empty(), AirdropError::BadEd25519Accounts);

        // Ed25519 Verification Instruction data
        let data = &ed_ix.data;

        // --- parse Ed25519 instruction format ---
        // First byte: number of signatures (must be 1)
        // Rest of header: offsets describing where signature, pubkey, and message are
        require!(data.len() >= HEADER_LEN, AirdropError::InvalidInstructionSysvar);
        let sig_count = data[0] as usize;
        require!(sig_count == 1, AirdropError::InvalidInstructionSysvar);

        // helper to read u16 offsets from the header (little-endian)
        let read_u16 = |i: usize| -> Result<u16> {
            let start = 2 + 2 * i;
            let end = start + 2;
            let src = data
                .get(start..end)
                .ok_or(error!(AirdropError::InvalidInstructionSysvar))?;
            let mut arr = [0u8; 2];
            arr.copy_from_slice(src);
            Ok(u16::from_le_bytes(arr))
        };

        // Extract the offsets for signature, pubkey, and message
        let signature_offset = read_u16(0)? as usize;
        let signature_ix_idx = read_u16(1)? as usize;
        let public_key_offset = read_u16(2)? as usize;
        let public_key_ix_idx = read_u16(3)? as usize;
        let message_offset = read_u16(4)? as usize;
        let message_size = read_u16(5)? as usize;
        let message_ix_idx = read_u16(6)? as usize;

        // Enforce that all offsets point to the current instruction's data.
        // The Ed25519 program uses u16::MAX as a sentinel value for "current instruction".
        // This prevents the program from accidentally reading signature, public key,
        // or message bytes from some other instruction in the transaction.
        let this_ix = u16::MAX as usize;
        require!(
            signature_ix_idx == this_ix
                && public_key_ix_idx == this_ix
                && message_ix_idx == this_ix,
            AirdropError::InvalidInstructionSysvar
        );

        // Ensure all offsets point beyond the 16-byte header,
        // i.e. into the region containing the signature, public key, and message
        require!(
            signature_offset >= HEADER_LEN
                 && public_key_offset >= HEADER_LEN
                 && message_offset >= HEADER_LEN,
            AirdropError::InvalidInstructionSysvar
        );

        // Bounds checks for signature, pubkey, and message slices
        require!(data.len() >= signature_offset + SIG_LEN, AirdropError::InvalidInstructionSysvar);
        require!(data.len() >= public_key_offset + PUBKEY_LEN, AirdropError::InvalidInstructionSysvar);
        require!(data.len() >= message_offset + message_size, AirdropError::InvalidInstructionSysvar);
        require!(message_size == MSG_LEN, AirdropError::InvalidInstructionSysvar);

        // --- reconstruct and validate the distributor's pubkey ---
        let pk_slice = &data[public_key_offset..public_key_offset + PUBKEY_LEN];
        let mut pk_arr = [0u8; 32];
        pk_arr.copy_from_slice(pk_slice);
        let distributor_pubkey = Pubkey::new_from_array(pk_arr);

        if distributor_pubkey != ctx.accounts.expected_distributor.key() {
            return err!(AirdropError::DistributorMismatch);
        }

        // --- reconstruct and validate the signed message ---
        // Format: [recipient pubkey (32 bytes)][amount (u64 little-endian)]
        let msg = &data[message_offset..message_offset + message_size];

        let mut rec_arr = [0u8; 32];
        rec_arr.copy_from_slice(&msg[0..32]);
        let recipient_from_msg = Pubkey::new_from_array(rec_arr);
        if recipient_from_msg != ctx.accounts.recipient.key() {
            return err!(AirdropError::RecipientMismatch);
        }

        let mut amount_bytes = [0u8; 8];
        amount_bytes.copy_from_slice(&msg[32..40]);
        let amount = u64::from_le_bytes(amount_bytes);

        // User can now claim the airdrop token.
        // The airdrop transfer can now be implemented here.

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Claim<'info> {
    /// The recipient of the airdrop (must match the recipient in the signed message)
    #[account(mut)]
    pub recipient: Signer<'info>,

    /// Expected distributor pubkey (checked against signed message, not Anchor)
    /// CHECK: Validated manually against the parsed message
    pub expected_distributor: UncheckedAccount<'info>,

    /// The sysvar containing the full transaction's instructions
    /// CHECK: Validated by requiring its well-known address
    #[account(address = ix_sysvar::Instructions::id())]
    pub instruction_sysvar: AccountInfo<'info>,

    /// System program used for the transfer
    pub system_program: Program<'info, System>,
}

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