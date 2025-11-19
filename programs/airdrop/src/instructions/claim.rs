use crate::constants::*;
use crate::errors::*;
use crate::state::*;
use crate::utils::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{sysvar::instructions as ix_sysvar, sysvar::SysvarId};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};
use borsh::BorshDeserialize;

//////////////////////////////// MESSAGE ////////////////////////////////

#[derive(BorshDeserialize)]
pub struct AirdropMessage {
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub project_nonce: u64,
    pub amount: u64,
    
    pub program_id: Pubkey,
    pub version: u8,
    pub nonce: u64,
    pub deadline: i64,
}

//////////////////////////////// INSTRUCTIONS ////////////////////////////////

#[derive(Accounts)]
#[instruction(project_nonce: u64, nonce: u64)]
pub struct Claim<'info> {
    /// The recipient of the airdrop (must match the recipient in the signed message)
    #[account(mut)]
    pub recipient: Signer<'info>,

    /// Expected distributor pubkey (checked against signed message, not Anchor)
    /// CHECK: Validated manually against the parsed message
    pub expected_distributor: UncheckedAccount<'info>,

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
            NULLIFIER_SEED_PREFIX,
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

        // Verify the Ed25519 signature and extract the signed message
        let (distributor_pubkey, message) = verify_ed25519_signature(&ix_sysvar_account)?;

        // Validate the distributor's public key
        require!(
            distributor_pubkey == self.expected_distributor.key(), // TODO: this should come from global config
            AirdropError::DistributorMismatch
        );

        // Deserialize the message using Borsh
        let airdrop_msg =
            AirdropMessage::try_from_slice(&message).map_err(|_| AirdropError::InvalidMessage)?;

        // Validate the nonce matches (prevents replay attacks)
        require!(
            airdrop_msg.nonce == nonce,
            AirdropError::NonceMismatch
        );

        // Validate the recipient matches
        require!(
            airdrop_msg.recipient == self.recipient.key(),
            AirdropError::RecipientMismatch
        );

        // Validate the project nonce matches
        require!(
            airdrop_msg.project_nonce == project_nonce,
            AirdropError::ProjectMismatch
        );

        // Validate the program_id matches
        require!(
            airdrop_msg.program_id == crate::ID,
            AirdropError::ProgramIdMismatch
        );

        // Validate the version matches (currently version 1)
        require!(
            airdrop_msg.version == 1,
            AirdropError::VersionMismatch
        );

        // Validate the deadline hasn't expired
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp <= airdrop_msg.deadline,
            AirdropError::DeadlineExpired
        );
        
        // Initialize the nullifier to mark this nonce as used
        // If this nonce was already used, the init constraint above would have failed
        self.nullifier.set_inner(ClaimNullifier {
            nonce,
            project: self.project.key(),
            recipient: self.recipient.key(),
            used_at: clock.unix_timestamp,
        });

        // Mint validations and transfers

        // Validate the mint in the message matches the provided mint account
        require!(
            airdrop_msg.mint == self.mint.key(),
            AirdropError::MintMismatch
        );

        // Validate the mint matches the project's mint
        require!(
            self.project.mint == self.mint.key(),
            AirdropError::MintMismatch
        );

   
        // Log all fields
        msg!("Airdrop Message Fields:");
        msg!("  Recipient: {}", airdrop_msg.recipient);
        msg!("  Amount: {}", airdrop_msg.amount);
        msg!("  Mint: {}", airdrop_msg.mint);
        msg!("  Deadline: {}", airdrop_msg.deadline);
        msg!("  Nonce: {}", airdrop_msg.nonce);
        msg!("  Project Nonce: {}", airdrop_msg.project_nonce);

        // Transfer tokens from project to recipient
        let nonce_bytes = project_nonce.to_le_bytes();
        let project_bump = get_project_bump(project_nonce, &crate::ID);
        let seeds = &[
            PROJECT_SEED_PREFIX,
            nonce_bytes.as_ref(),
            &[project_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        transfer_spl(
            self.token_program.to_account_info(),
            self.project.to_account_info(),
            self.project_token_account.to_account_info(),
            self.recipient_token_account.to_account_info(),
            airdrop_msg.amount,
            Some(signer_seeds),
        )?;

        msg!("Successfully transferred {} tokens to recipient", airdrop_msg.amount);

        Ok(())
    }
}
