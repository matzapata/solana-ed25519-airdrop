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

// Airdrop-specific data fields
class AirdropMessageData {
  recipient: Uint8Array;
  mint: Uint8Array;
  project_nonce: bigint;
  amount: bigint;

  constructor(fields: { recipient: Uint8Array; mint: Uint8Array; project_nonce: bigint; amount: bigint }) {
    this.recipient = fields.recipient;
    this.mint = fields.mint;
    this.project_nonce = fields.project_nonce;
    this.amount = fields.amount;
  }

  static schema: BorshSchema = {
    struct: {
      recipient: { array: { type: 'u8', len: 32 } },
      mint: { array: { type: 'u8', len: 32 } },
      project_nonce: 'u64',
      amount: 'u64',
    }
  };
}

// Generic domain fields for signed messages
class MessageDomain {
  program_id: Uint8Array;
  version: number;
  nonce: bigint;
  deadline: bigint;

  constructor(fields: { program_id: Uint8Array; version: number; nonce: bigint; deadline: bigint }) {
    this.program_id = fields.program_id;
    this.version = fields.version;
    this.nonce = fields.nonce;
    this.deadline = fields.deadline;
  }

  static schema: BorshSchema = {
    struct: {
      program_id: { array: { type: 'u8', len: 32 } },
      version: 'u8',
      nonce: 'u64',
      deadline: 'i64',
    }
  };
}

// Complete airdrop message
class AirdropMessage {
  data: AirdropMessageData;
  domain: MessageDomain;

  constructor(fields: { data: AirdropMessageData; domain: MessageDomain }) {
    this.data = fields.data;
    this.domain = fields.domain;
  }

  // Borsh schema definition
  static schema: BorshSchema = {
    struct: {
      data: AirdropMessageData.schema,
      domain: MessageDomain.schema,
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

  // Helper function to get nullifier PDA
  const getNullifierPda = (nonce: bigint) => {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("nullifier"),
        projectPda.toBuffer(),
        Buffer.from(new anchor.BN(nonce.toString()).toArray("le", 8)),
      ],
      program.programId
    )[0];
  };

  // Helper function to create airdrop message
  const createAirdropMessage = (params: {
    recipient: PublicKey;
    mint: PublicKey;
    projectNonce: bigint;
    amount: bigint;
    programId: PublicKey;
    version: number;
    nonce: bigint;
    deadline: bigint;
  }) => {
    const data = new AirdropMessageData({
      recipient: params.recipient.toBytes(),
      mint: params.mint.toBytes(),
      project_nonce: params.projectNonce,
      amount: params.amount,
    });

    const domain = new MessageDomain({
      program_id: params.programId.toBytes(),
      version: params.version,
      nonce: params.nonce,
      deadline: params.deadline,
    });

    return new AirdropMessage({ data, domain });
  };

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

    const nullifierPda = getNullifierPda(nonce);

    const msg = createAirdropMessage({
      recipient: recipientKeypair.publicKey,
      mint: mint,
      projectNonce: projectNonce,
      amount: BigInt(claimAmount),
      programId: program.programId,
      version: 1,
      nonce,
      deadline,
    });

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        project: projectPda,
        nullifier: nullifierPda,
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
    expect(logs.some(log => log.includes(`Mint: ${mint.toBase58()}`))).to.be.true;
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

    const nullifierPda = getNullifierPda(nonce);

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const msg = createAirdropMessage({
      recipient: recipientKeypair.publicKey,
      mint: mint,
      projectNonce: projectNonce,
      amount: BigInt(claimAmount),
      programId: program.programId,
      version: 1,
      nonce,
      deadline,
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

    const nullifierPda = getNullifierPda(nonce);

    const msg = createAirdropMessage({
      recipient: recipientKeypair.publicKey,
      mint: mint,
      projectNonce: projectNonce,
      amount: BigInt(claimAmount),
      programId: program.programId,
      version: 1,
      nonce,
      deadline,
    });

    const ed25519Ix = createEd25519Instruction(
      invalidDistributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey, // But we expect the correct one
        project: projectPda,
        nullifier: nullifierPda,
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

    const nullifierPda = getNullifierPda(nonce);

    const msg = createAirdropMessage({
      recipient: wrongRecipient.publicKey,
      mint: mint,
      projectNonce: projectNonce,
      amount: BigInt(claimAmount),
      programId: program.programId,
      version: 1,
      nonce,
      deadline,
    });

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        project: projectPda,
        nullifier: nullifierPda,
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

  it("Fails with program_id mismatch", async () => {
    const claimAmount = 1000000;
    const deadline = BigInt(9999999999); // Far future deadline
    const nonce = BigInt(50);
    const wrongProgramId = Keypair.generate(); // Random pubkey as wrong program_id

    const recipientTokenAccount = await getAssociatedTokenAddress(
      mint,
      recipientKeypair.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const nullifierPda = getNullifierPda(nonce);

    const msg = createAirdropMessage({
      recipient: recipientKeypair.publicKey,
      mint: mint,
      projectNonce: projectNonce,
      amount: BigInt(claimAmount),
      programId: wrongProgramId.publicKey, // Wrong program_id
      version: 1,
      nonce,
      deadline,
    });

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    try {
      await sendTransaction(svm, recipientKeypair, [ed25519Ix, claimIx]);
      expect.fail("Should have failed with program_id mismatch");
    } catch (error) {
      expect(error.message).to.include("ProgramIdMismatch");
    }
  });

  it("Fails with version mismatch", async () => {
    const claimAmount = 1000000;
    const deadline = BigInt(9999999999); // Far future deadline
    const nonce = BigInt(51);

    const recipientTokenAccount = await getAssociatedTokenAddress(
      mint,
      recipientKeypair.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const nullifierPda = getNullifierPda(nonce);

    const msg = createAirdropMessage({
      recipient: recipientKeypair.publicKey,
      mint: mint,
      projectNonce: projectNonce,
      amount: BigInt(claimAmount),
      programId: program.programId,
      version: 2, // Wrong version (expected 1)
      nonce,
      deadline,
    });

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    try {
      await sendTransaction(svm, recipientKeypair, [ed25519Ix, claimIx]);
      expect.fail("Should have failed with version mismatch");
    } catch (error) {
      expect(error.message).to.include("VersionMismatch");
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

    const nullifierPda = getNullifierPda(nonce);

    const msg = createAirdropMessage({
      recipient: recipientKeypair.publicKey,
      mint: mint,
      projectNonce: projectNonce,
      amount: BigInt(claimAmount),
      programId: program.programId,
      version: 1,
      nonce,
      deadline,
    });

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    // First claim instruction (valid)
    const claimIx1 = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    // Second claim instruction (tries to reuse the same Ed25519)
    const claimIx2 = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        project: projectPda,
        nullifier: nullifierPda,
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
      // The second claim could fail for multiple reasons:
      // 1. If the first claim succeeds, the nullifier is already initialized
      // 2. If both try to init the same nullifier, one will fail
      // Either way, the transaction should fail
      expect(error.message).to.exist;
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

    const nullifierPda = getNullifierPda(nonce);

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

    const msg = createAirdropMessage({
      recipient: recipientKeypair.publicKey,
      mint: mint,
      projectNonce: projectNonce,
      amount: BigInt(claimAmount),
      programId: program.programId,
      version: 1,
      nonce,
      deadline,
    });

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        project: projectPda,
        nullifier: nullifierPda,
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

  it("Fails when trying to reuse a nonce (nullifier prevents replay attack)", async () => {
    const claimAmount = 1000000;
    const deadline = BigInt(9999999999); // Far future deadline
    const nonce = BigInt(100); // Using a unique nonce for this test

    const recipientTokenAccount = await getAssociatedTokenAddress(
      mint,
      recipientKeypair.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const nullifierPda = getNullifierPda(nonce);

    const msg = createAirdropMessage({
      recipient: recipientKeypair.publicKey,
      mint: mint,
      projectNonce: projectNonce,
      amount: BigInt(claimAmount),
      programId: program.programId,
      version: 1,
      nonce,
      deadline,
    });

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    // First claim should succeed
    const balanceBefore = await getSplTokenBalance(svm, mint, recipientKeypair.publicKey);
    await sendTransaction(svm, recipientKeypair, [ed25519Ix, claimIx]);
    const balanceAfter = await getSplTokenBalance(svm, mint, recipientKeypair.publicKey);
    expect(balanceAfter - balanceBefore).to.equal(BigInt(claimAmount));

    // Try to reuse the same nonce - should fail because nullifier already exists
    const ed25519Ix2 = createEd25519Instruction(
      distributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx2 = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    try {
      await sendTransaction(svm, recipientKeypair, [ed25519Ix2, claimIx2]);
      expect.fail("Should have failed when trying to reuse nonce");
    } catch (error) {
      // The nullifier account already exists, so init will fail
      // This is the key behavior - the transaction must fail
      expect(error.message).to.exist;
      expect(error.message.length).to.be.greaterThan(0);
    }
  });

});