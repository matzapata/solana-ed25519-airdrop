import * as anchor from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  getAccount,
  getAssociatedTokenAddress,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { LiteSVMProvider } from 'anchor-litesvm';
import { sendTransaction } from './svm';
import { LiteSVM } from 'litesvm';

export const createSplToken = async (
  provider: LiteSVMProvider,
  owner: Keypair,
  decimals: number = 9,
) => {
  const mintKeypair = Keypair.generate();
  const lamports = await getMinimumBalanceForRentExemptMint(provider.connection);

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: owner.publicKey,
    newAccountPubkey: mintKeypair.publicKey,
    lamports,
    space: MINT_SIZE,
    programId: TOKEN_PROGRAM_ID,
  });

  const initializeMintIx = createInitializeMint2Instruction(
    mintKeypair.publicKey,
    decimals,
    owner.publicKey, // mint authority
    null, // freeze authority
    TOKEN_PROGRAM_ID,
  );

  await provider.sendAndConfirm(
    new anchor.web3.Transaction().add(createAccountIx, initializeMintIx),
    [owner, mintKeypair],
  );

  return mintKeypair.publicKey;
};

export const getOrCreateAssociatedTokenAccount = async (
  svm: LiteSVM,
  mint: PublicKey,
  owner: PublicKey,
  ownerIsPda: boolean,
  payer: Keypair,
) => {
  const ata = await getAssociatedTokenAddress(
    mint,
    owner,
    ownerIsPda,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const ataInfo = svm.getAccount(ata);
  if (!ataInfo) {
    const createAtaIx = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      owner,
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    await sendTransaction(svm, payer, [createAtaIx]);
  }
  return ata;
};

export const getSplTokenBalance = async (
  svm: LiteSVM,
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
) => {
  const ata = await getAssociatedTokenAddress(
    mint,
    owner,
    allowOwnerOffCurve,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const ataInfo = await getAccount(
    new LiteSVMProvider(svm).connection,
    ata,
    undefined,
    TOKEN_PROGRAM_ID,
  );
  return BigInt(ataInfo?.amount ?? 0);
};
