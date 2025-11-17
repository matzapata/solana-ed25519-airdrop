use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    sysvar::instructions as ix_sysvar,
    sysvar::SysvarId
};
use crate::errors::*;
use crate::utils::ed25519::verify_ed25519_signature;

//////////////////////////////// INSTRUCTIONS ////////////////////////////////

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

//////////////////////////////// HANDLERS ////////////////////////////////

impl<'info> Claim<'info> {
    pub fn claim(&self) -> Result<()> {
        // Expected message length: [recipient(32) + amount(8)]
        const MSG_LEN: usize = 40;

        // Load the instruction sysvar account (holds all tx instructions)
        let ix_sysvar_account = self.instruction_sysvar.to_account_info();

        // Verify the Ed25519 signature and extract the signed message
        let (distributor_pubkey, message) = verify_ed25519_signature(&ix_sysvar_account, MSG_LEN)?;

        // Validate the distributor's public key
        require!(
            distributor_pubkey == self.expected_distributor.key(),
            AirdropError::DistributorMismatch
        );

        // Parse and validate the message: [recipient pubkey (32 bytes)][amount (u64 little-endian)]
        let mut recipient_bytes = [0u8; 32];
        recipient_bytes.copy_from_slice(&message[0..32]);
        let recipient_from_msg = Pubkey::new_from_array(recipient_bytes);
        
        require!(
            recipient_from_msg == self.recipient.key(),
            AirdropError::RecipientMismatch
        );

        let mut amount_bytes = [0u8; 8];
        amount_bytes.copy_from_slice(&message[32..40]);
        let _amount = u64::from_le_bytes(amount_bytes);

        // User can now claim the airdrop token.
        // The airdrop transfer can now be implemented here.

        Ok(())
    }
}
