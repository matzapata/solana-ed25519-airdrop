import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Airdrop } from "../../target/types/airdrop";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { LiteSVM, Clock } from "litesvm";
import { fromWorkspace, LiteSVMProvider } from 'anchor-litesvm';
import { sendTransaction } from "../utils/svm";
import { Schema as BorshSchema, serialize } from "borsh";
import { createEd25519Instruction } from "../utils/ed25519";
import { createSplToken, getSplTokenBalance } from "../utils/spl";
import { createMintToInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

// Define the message structure for Borsh serialization
class AirdropMessage {
  recipient: Uint8Array;
  partner: Uint8Array;
  amount: bigint;
  deadline: bigint;
  nonce: bigint;
  project_nonce: bigint;

  constructor(fields: { recipient: Uint8Array; partner: Uint8Array; amount: bigint; deadline: bigint; nonce: bigint; project_nonce: bigint }) {
    this.recipient = fields.recipient;
    this.partner = fields.partner;
    this.amount = fields.amount;
    this.deadline = fields.deadline;
    this.nonce = fields.nonce;
    this.project_nonce = fields.project_nonce;
  }

  // Borsh schema definition
  static schema: BorshSchema = {
    struct: {
      recipient: { array: { type: 'u8', len: 32 } },
      partner: { array: { type: 'u8', len: 32 } },
      amount: 'u64',
      deadline: 'i64',
      nonce: 'u64',
      project_nonce: 'u64',
    }
  };
}


describe("claim", () => {
  let svm: LiteSVM;
  let provider: LiteSVMProvider;
  let program: Program<Airdrop>;

  // Test accounts
  let distributorKeypair: Keypair;
  let recipientKeypair: Keypair;
  let invalidDistributorKeypair: Keypair;
  let partnerKeypair: Keypair;
  let authorityKeypair: Keypair;

  // Project and token accounts
  let projectNonce: bigint;
  let projectPda: PublicKey;
  let mint: PublicKey;
  let projectTokenAccount: PublicKey;

  before(async () => {
    svm = fromWorkspace('./')
      .withBuiltins()
      .withSysvars()
      .withDefaultPrograms()
      .withPrecompiles();
    provider = new LiteSVMProvider(svm);
    anchor.setProvider(provider);
    program = anchor.workspace.Airdrop as Program<Airdrop>;

    distributorKeypair = Keypair.generate();
    recipientKeypair = Keypair.generate();
    invalidDistributorKeypair = Keypair.generate();
    partnerKeypair = Keypair.generate();
    authorityKeypair = Keypair.generate();

    await svm.airdrop(recipientKeypair.publicKey, BigInt(10000000000));
    await svm.airdrop(distributorKeypair.publicKey, BigInt(10000000000));
    await svm.airdrop(invalidDistributorKeypair.publicKey, BigInt(10000000000));
    await svm.airdrop(partnerKeypair.publicKey, BigInt(10000000000));
    await svm.airdrop(authorityKeypair.publicKey, BigInt(10000000000));

    // Create SPL token mint
    mint = await createSplToken(provider, authorityKeypair, 9);

    // Initialize project
    projectNonce = BigInt(1);
    [projectPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("project"), Buffer.from(new anchor.BN(projectNonce.toString()).toArray("le", 8))],
      program.programId
    );

    projectTokenAccount = await getAssociatedTokenAddress(
      mint,
      projectPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    await program.methods
      .createProject(new anchor.BN(projectNonce.toString()))
      .accountsPartial({
        authority: authorityKeypair.publicKey,
        project: projectPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
      })
      .signers([authorityKeypair])
      .rpc();

    // Mint tokens to the project token account
    const mintToIx = createMintToInstruction(
      mint,
      projectTokenAccount,
      authorityKeypair.publicKey,
      BigInt(1000000000), // 1 billion tokens
      [],
      TOKEN_PROGRAM_ID
    );

    await sendTransaction(svm, authorityKeypair, [mintToIx]);
  });


  it("Successfully claims airdrop with valid signature", async () => {
    const claimAmount = 1000000;
    const deadline = BigInt(9999999999); // Far future deadline
    const nonce = BigInt(1);

    const recipientTokenAccount = await getAssociatedTokenAddress(
      mint,
      recipientKeypair.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const msg = new AirdropMessage({
      recipient: recipientKeypair.publicKey.toBytes(),
      partner: partnerKeypair.publicKey.toBytes(),
      amount: BigInt(claimAmount),
      deadline,
      nonce,
      project_nonce: projectNonce,
    });

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        project: projectPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const balanceBefore = await getSplTokenBalance(svm, mint, recipientKeypair.publicKey);
    const { signature, logs } = await sendTransaction(svm, recipientKeypair, [ed25519Ix, claimIx]);
    const balanceAfter = await getSplTokenBalance(svm, mint, recipientKeypair.publicKey);

    expect(signature).to.exist;
    expect(balanceAfter - balanceBefore).to.equal(BigInt(claimAmount));
    
    // Verify the logged fields
    expect(logs.some(log => log.includes("Airdrop Message Fields:"))).to.be.true;
    expect(logs.some(log => log.includes(`Recipient: ${recipientKeypair.publicKey.toBase58()}`))).to.be.true;
    expect(logs.some(log => log.includes(`Amount: ${claimAmount}`))).to.be.true;
    expect(logs.some(log => log.includes(`Partner: ${partnerKeypair.publicKey.toBase58()}`))).to.be.true;
    expect(logs.some(log => log.includes(`Successfully transferred ${claimAmount} tokens to recipient`))).to.be.true;
  });

  it("Fails when Ed25519 instruction is not first", async () => {
    const claimAmount = 1000000;
    const deadline = BigInt(9999999999); // Far future deadline
    const nonce = BigInt(2);

    const recipientTokenAccount = await getAssociatedTokenAddress(
      mint,
      recipientKeypair.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        project: projectPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const msg = new AirdropMessage({
      recipient: recipientKeypair.publicKey.toBytes(),
      partner: partnerKeypair.publicKey.toBytes(),
      amount: BigInt(claimAmount),
      deadline,
      nonce,
      project_nonce: projectNonce,
    });

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    try {
      // Create transaction with claim first, then Ed25519 (wrong order)
      await sendTransaction(svm, recipientKeypair, [claimIx, ed25519Ix]);
      expect.fail("Should have failed with wrong instruction order");
    } catch (error) {
      expect(error.message).to.include("InvalidInstructionSysvar");
    }
  });

  it("Fails with distributor mismatch", async () => {
    const claimAmount = 1000000;
    const deadline = BigInt(9999999999); // Far future deadline
    const nonce = BigInt(3);

    const recipientTokenAccount = await getAssociatedTokenAddress(
      mint,
      recipientKeypair.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const msg = new AirdropMessage({
      recipient: recipientKeypair.publicKey.toBytes(),
      partner: partnerKeypair.publicKey.toBytes(),
      amount: BigInt(claimAmount),
      deadline,
      nonce,
      project_nonce: projectNonce,
    });

    const ed25519Ix = createEd25519Instruction(
      invalidDistributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey, // But we expect the correct one
        project: projectPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    try {
      await sendTransaction(svm, recipientKeypair, [ed25519Ix, claimIx]);
      expect.fail("Should have failed with distributor mismatch");
    } catch (error) {
      expect(error.message).to.include("DistributorMismatch");
    }
  });

  it("Fails with recipient mismatch", async () => {
    const claimAmount = 1000000;
    const deadline = BigInt(9999999999); // Far future deadline
    const nonce = BigInt(4);
    const wrongRecipient = Keypair.generate();

    const recipientTokenAccount = await getAssociatedTokenAddress(
      mint,
      recipientKeypair.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const msg = new AirdropMessage({
      recipient: wrongRecipient.publicKey.toBytes(),
      partner: partnerKeypair.publicKey.toBytes(),
      amount: BigInt(claimAmount),
      deadline,
      nonce,
      project_nonce: projectNonce,
    });

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        project: projectPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    try {
      await sendTransaction(svm, recipientKeypair, [ed25519Ix, claimIx]);
      expect.fail("Should have failed with recipient mismatch");
    } catch (error) {
      expect(error.message).to.include("RecipientMismatch");
    }
  });

  it("Fails when multiple claim instructions try to reuse the same Ed25519 signature", async () => {
    const claimAmount = 1000000;
    const deadline = BigInt(9999999999); // Far future deadline
    const nonce = BigInt(5);

    const recipientTokenAccount = await getAssociatedTokenAddress(
      mint,
      recipientKeypair.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const msg = new AirdropMessage({
      recipient: recipientKeypair.publicKey.toBytes(),
      partner: partnerKeypair.publicKey.toBytes(),
      amount: BigInt(claimAmount),
      deadline,
      nonce,
      project_nonce: projectNonce,
    });

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    // First claim instruction (valid)
    const claimIx1 = await program.methods
      .claim(new anchor.BN(projectNonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        project: projectPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    // Second claim instruction (tries to reuse the same Ed25519)
    const claimIx2 = await program.methods
      .claim(new anchor.BN(projectNonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        project: projectPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    try {
      await sendTransaction(svm, recipientKeypair, [ed25519Ix, claimIx1, claimIx2]);
      expect.fail("Should have failed because multiple claims tried to reuse the same signature");
    } catch (error) {
      // The second claim fails because its immediately preceding instruction
      // is not the Ed25519 verification, so the program throws
      expect(error.message).to.include("BadEd25519Program");
    }
  });

  it("Fails when deadline has expired", async () => {
    const claimAmount = 1000000;
    const deadline = BigInt(1000); // Set deadline to unix timestamp 1000
    const nonce = BigInt(6);

    const recipientTokenAccount = await getAssociatedTokenAddress(
      mint,
      recipientKeypair.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Set the clock to a time after the deadline
    const currentClock = svm.getClock();
    const expiredClock = new Clock(
      currentClock.slot,
      currentClock.epochStartTimestamp,
      currentClock.epoch,
      currentClock.leaderScheduleEpoch,
      BigInt(2000) // Set unix timestamp to 2000, which is after the deadline of 1000
    );
    svm.setClock(expiredClock);

    const msg = new AirdropMessage({
      recipient: recipientKeypair.publicKey.toBytes(),
      partner: partnerKeypair.publicKey.toBytes(),
      amount: BigInt(claimAmount),
      deadline,
      nonce,
      project_nonce: projectNonce,
    });

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        project: projectPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    try {
      await sendTransaction(svm, recipientKeypair, [ed25519Ix, claimIx]);
      expect.fail("Should have failed with expired deadline");
    } catch (error) {
      expect(error.message).to.include("DeadlineExpired");
    }
  });

});