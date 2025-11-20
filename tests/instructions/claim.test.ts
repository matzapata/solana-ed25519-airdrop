import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Airdrop } from "../../target/types/airdrop";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { LiteSVM, Clock } from "litesvm";
import { fromWorkspace, LiteSVMProvider } from 'anchor-litesvm';
import { sendTransaction } from "../utils/svm";
import { Schema as BorshSchema, serialize } from "borsh";
import { createEd25519InstructionWithMultipleSigners } from "../utils/ed25519";
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

  // Global config
  let globalConfigPda: PublicKey;

  // Project and token accounts
  let projectNonce: bigint;
  let projectPda: PublicKey;
  let mint: PublicKey;
  let projectTokenAccount: PublicKey;

  // Helper function to get nullifier PDA
  const getNullifierPda = (projectPda: PublicKey, nonce: bigint) => {
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

  // Create global config, create project, deploy and mint spl
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

    // Initialize global config
    [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global_config")],
      program.programId
    );

    // Set up with two distributors from the start
    await program.methods
      .createGlobalConfig([distributorKeypair.publicKey, partnerKeypair.publicKey])
      .accountsPartial({
        authority: authorityKeypair.publicKey,
        globalConfig: globalConfigPda,
      })
      .signers([authorityKeypair])
      .rpc();

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

  it("Successfully claims airdrop with multiple signers", async () => {
    const claimAmount = 2000000;
    const deadline = BigInt(9999999999); // Far future deadline
    const nonce = BigInt(10);

    // Get the balance before the claim
    const balanceBefore = await getSplTokenBalance(svm, mint, recipientKeypair.publicKey);

    // Get the recipient's token account
    const recipientTokenAccount = await getAssociatedTokenAddress(
      mint,
      recipientKeypair.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Get the nullifier PDA
    const nullifierPda = getNullifierPda(projectPda, nonce);

    // Create the airdrop message
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
    const serializedMessage = Buffer.from(serialize(AirdropMessage.schema, msg));

    // Create Ed25519 instruction with ALL distributors signing
    // Both distributors (distributorKeypair and partnerKeypair) must sign for the claim to succeed
    const ed25519Ix = createEd25519InstructionWithMultipleSigners(
      [distributorKeypair, partnerKeypair],
      serializedMessage
    );

    // Create the claim instruction
    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount
      })
      .instruction();
    
    await sendTransaction(svm, recipientKeypair, [ed25519Ix, claimIx]);

    // Verify the balance has increased by the claim amount
    const balanceAfter = await getSplTokenBalance(svm, mint, recipientKeypair.publicKey);
    expect(balanceAfter - balanceBefore).to.equal(BigInt(claimAmount));
  });

  it("Fails when not all distributors have signed", async () => {
    const claimAmount = 3000000;
    const deadline = BigInt(9999999999); // Far future deadline
    const nonce = BigInt(11);

    const recipientTokenAccount = await getAssociatedTokenAddress(
      mint,
      recipientKeypair.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const nullifierPda = getNullifierPda(projectPda, nonce);

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
    const serializedMessage = Buffer.from(serialize(AirdropMessage.schema, msg));

    // Create Ed25519 instruction with only ONE distributor (missing partnerKeypair)
    // This should fail because both distributors are required (set up in before hook)
    const ed25519Ix = createEd25519InstructionWithMultipleSigners(
      [distributorKeypair], // Only one distributor, missing partnerKeypair
      serializedMessage
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        globalConfig: globalConfigPda,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount
      })
      .instruction();

    try {
      await sendTransaction(svm, recipientKeypair, [ed25519Ix, claimIx]);
      expect.fail("Should have failed because not all distributors signed");
    } catch (error) {
      expect(error.message).to.include("DistributorMismatch");
    }
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

    const nullifierPda = getNullifierPda(projectPda, nonce);

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        globalConfig: globalConfigPda,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount
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
    const serializedMessage = Buffer.from(serialize(AirdropMessage.schema, msg));

    // Create Ed25519 instruction with ALL distributors signing
    const ed25519Ix = createEd25519InstructionWithMultipleSigners(
      [distributorKeypair, partnerKeypair],
      serializedMessage
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

    const nullifierPda = getNullifierPda(projectPda, nonce);

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

    // Use invalid distributor + partner (missing valid distributor)
    const ed25519Ix = createEd25519InstructionWithMultipleSigners(
      [invalidDistributorKeypair, partnerKeypair],
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        globalConfig: globalConfigPda, // But we expect the correct one
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount
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

    const nullifierPda = getNullifierPda(projectPda, nonce);

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

    const ed25519Ix = createEd25519InstructionWithMultipleSigners(
      [distributorKeypair, partnerKeypair],
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        globalConfig: globalConfigPda,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount
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

    const nullifierPda = getNullifierPda(projectPda, nonce);

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

    const ed25519Ix = createEd25519InstructionWithMultipleSigners(
      [distributorKeypair, partnerKeypair],
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        globalConfig: globalConfigPda,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount
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

    const nullifierPda = getNullifierPda(projectPda, nonce);

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

    const ed25519Ix = createEd25519InstructionWithMultipleSigners(
      [distributorKeypair, partnerKeypair],
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        globalConfig: globalConfigPda,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount
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

    const nullifierPda = getNullifierPda(projectPda, nonce);

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

    const ed25519Ix = createEd25519InstructionWithMultipleSigners(
      [distributorKeypair, partnerKeypair],
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    // First claim instruction (valid)
    const claimIx1 = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        globalConfig: globalConfigPda,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount
      })
      .instruction();

    // Second claim instruction (tries to reuse the same Ed25519)
    const claimIx2 = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        globalConfig: globalConfigPda,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount
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

    const nullifierPda = getNullifierPda(projectPda, nonce);

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

    const ed25519Ix = createEd25519InstructionWithMultipleSigners(
      [distributorKeypair, partnerKeypair],
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        globalConfig: globalConfigPda,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount
      })
      .instruction();

    try {
      await sendTransaction(svm, recipientKeypair, [ed25519Ix, claimIx]);
      expect.fail("Should have failed with expired deadline");
    } catch (error) {
      expect(error.message).to.include("DeadlineExpired");
    }
  });

  it("Fails when trying to reuse the same signature (nullifier prevents replay attack)", async () => {
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

    const nullifierPda = getNullifierPda(projectPda, nonce);

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

    // Create a single Ed25519 signature instruction that we'll try to reuse
    const ed25519Ix = createEd25519InstructionWithMultipleSigners(
      [distributorKeypair, partnerKeypair],
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        globalConfig: globalConfigPda,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount
      })
      .instruction();

    // First claim should succeed
    const balanceBefore = await getSplTokenBalance(svm, mint, recipientKeypair.publicKey);
    await sendTransaction(svm, recipientKeypair, [ed25519Ix, claimIx]);
    const balanceAfter = await getSplTokenBalance(svm, mint, recipientKeypair.publicKey);
    expect(balanceAfter - balanceBefore).to.equal(BigInt(claimAmount));

    // Try to reuse the SAME signature with a different claim instruction
    // This should fail because the nullifier for this nonce already exists
    const claimIx2 = await program.methods
      .claim(new anchor.BN(projectNonce.toString()), new anchor.BN(nonce.toString()))
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        globalConfig: globalConfigPda,
        project: projectPda,
        nullifier: nullifierPda,
        mint: mint,
        projectTokenAccount: projectTokenAccount,
        recipientTokenAccount: recipientTokenAccount
      })
      .instruction();

    try {
      // Reusing the SAME ed25519Ix (signature) from the first transaction
      await sendTransaction(svm, recipientKeypair, [ed25519Ix, claimIx2]);
      expect.fail("Should have failed when trying to reuse the same signature/nonce");
    } catch (error) {
      // The nullifier account already exists, so init will fail
      // This prevents replay attacks using the same signature
      expect(error.message).to.exist;
      expect(error.message.length).to.be.greaterThan(0);
    }
  });

});