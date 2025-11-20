use crate::{constants::*, errors::*, state::*, utils::*};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{sysvar::instructions as ix_sysvar, sysvar::SysvarId};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};
use borsh::BorshDeserialize;

//////////////////////////////// MESSAGE ////////////////////////////////

/// Domain-specific fields for airdrop claims
#[derive(BorshDeserialize)]
pub struct AirdropMessageData {
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub project_nonce: u64,
    pub amount: u64,
}

/// Complete airdrop message with domain data and metadata
#[derive(BorshDeserialize)]
pub struct AirdropMessage {
    pub data: AirdropMessageData,
    pub domain: MessageDomain,
}

//////////////////////////////// INSTRUCTIONS ////////////////////////////////

#[derive(Accounts)]
#[instruction(project_nonce: u64, nonce: u64)]
pub struct Claim<'info> {
    /// The recipient of the airdrop (must match the recipient in the signed message)
    #[account(mut)]
    pub recipient: Signer<'info>,

    /// The global config PDA containing the distributor public key
    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump
    )]
    pub global_config: Account<'info, GlobalConfig>,

    /// The project PDA from which tokens will be claimed
    #[account(
        seeds = [PROJECT_SEED_PREFIX, project_nonce.to_le_bytes().as_ref()],
        bump
    )]
    pub project: Account<'info, Project>,

    /// Nullifier account to prevent nonce reuse (acts as a nullifier)
    /// If this account already exists, the transaction will fail, preventing replay attacks
    #[account(
        init,
        payer = recipient,
        space = ClaimNullifier::DISCRIMINATOR.len() + ClaimNullifier::INIT_SPACE,
        seeds = [
            CLAIM_NULLIFIER_SEED_PREFIX,
            project.key().as_ref(),
            nonce.to_le_bytes().as_ref(),
        ],
        bump
    )]
    pub nullifier: Account<'info, ClaimNullifier>,

    /// The mint of the SPL token being distributed
    pub mint: Account<'info, Mint>,

    /// The token account owned by the project PDA (source of tokens)
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = project
    )]
    pub project_token_account: Account<'info, TokenAccount>,

    /// The recipient's token account (destination of tokens)
    #[account(
        init_if_needed,
        payer = recipient,
        associated_token::mint = mint,
        associated_token::authority = recipient
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// The sysvar containing the full transaction's instructions
    /// CHECK: Validated by requiring its well-known address
    #[account(address = ix_sysvar::Instructions::id())]
    pub instruction_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

//////////////////////////////// HANDLERS ////////////////////////////////

impl<'info> Claim<'info> {
    pub fn claim(&mut self, project_nonce: u64, nonce: u64) -> Result<()> {
        // Load the instruction sysvar account (holds all tx instructions)
        let ix_sysvar_account = self.instruction_sysvar.to_account_info();

        // Verify the Ed25519 signatures and extract signers and message
        let (signers, message) = verify_ed25519_signature(&ix_sysvar_account)?;
        require!(!signers.is_empty(), AirdropError::InvalidInstructionSysvar);

        // Validate that ALL distributors have signed the message
        require!(
            signers.len() >= self.global_config.distributors.len(),
            AirdropError::DistributorMismatch
        );

        // Check that every distributor is present in the signers
        for distributor in self.global_config.distributors.iter() {
            require!(
                signers.contains(distributor),
                AirdropError::DistributorMismatch
            );
        }

        // Deserialize the message using Borsh
        let airdrop_msg =
            AirdropMessage::try_from_slice(&message).map_err(|_| AirdropError::InvalidMessage)?;

        // Validate generic signed message fields (program_id, version, deadline)
        validate_message_domain(&airdrop_msg.domain, nonce)?;

        // Initialize the nullifier to mark this nonce as used
        // If this nonce was already used, the init constraint above would have failed
        self.nullifier.set_inner(ClaimNullifier { nonce });

        // Validate data

        require!(
            airdrop_msg.data.project_nonce == project_nonce,
            AirdropError::ProjectMismatch
        );
        require!(
            airdrop_msg.data.recipient == self.recipient.key(),
            AirdropError::RecipientMismatch
        );
        require!(
            airdrop_msg.data.mint == self.mint.key(),
            AirdropError::MintMismatch
        );
        require!(
            self.project.mint == self.mint.key(),
            AirdropError::MintMismatch
        );

        // Log all fields
        msg!("Airdrop Message Fields:");
        msg!("  Recipient: {}", airdrop_msg.data.recipient);
        msg!("  Amount: {}", airdrop_msg.data.amount);
        msg!("  Mint: {}", airdrop_msg.data.mint);
        msg!("  Deadline: {}", airdrop_msg.domain.deadline);
        msg!("  Nonce: {}", airdrop_msg.domain.nonce);
        msg!("  Project Nonce: {}", airdrop_msg.data.project_nonce);

        // Transfer tokens from project to recipient
        let nonce_bytes = project_nonce.to_le_bytes();
        let project_bump = get_project_bump(project_nonce, &crate::ID);
        let seeds = &[PROJECT_SEED_PREFIX, nonce_bytes.as_ref(), &[project_bump]];
        let signer_seeds = &[&seeds[..]];

        transfer_spl(
            self.token_program.to_account_info(),
            self.project.to_account_info(),
            self.project_token_account.to_account_info(),
            self.recipient_token_account.to_account_info(),
            airdrop_msg.data.amount,
            Some(signer_seeds),
        )?;

        msg!(
            "Successfully transferred {} tokens to recipient",
            airdrop_msg.data.amount
        );

        Ok(())
    }
}
