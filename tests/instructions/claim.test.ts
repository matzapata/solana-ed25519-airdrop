import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Airdrop } from "../../target/types/airdrop";
import { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import { LiteSVM, } from "litesvm";
import { fromWorkspace, LiteSVMProvider } from 'anchor-litesvm';
import { sendTransaction } from "../utils/svm";
import { Schema as BorshSchema, serialize } from "borsh";
import { createEd25519Instruction } from "../utils/ed25519";

// Define the message structure for Borsh serialization
class AirdropMessage {
  recipient: Uint8Array;
  amount: bigint;

  constructor(fields: { recipient: Uint8Array; amount: bigint }) {
    this.recipient = fields.recipient;
    this.amount = fields.amount;
  }

  // Borsh schema definition
  static schema: BorshSchema = {
    struct: {
      recipient: { array: { type: 'u8', len: 32 } },
      amount: 'u64',
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

    await svm.airdrop(recipientKeypair.publicKey, BigInt(1000000));
    await svm.airdrop(distributorKeypair.publicKey, BigInt(1000000));
    await svm.airdrop(invalidDistributorKeypair.publicKey, BigInt(1000000));
  });


  it("Successfully claims airdrop with valid signature", async () => {
    const claimAmount = 1000000;

    const msg = new AirdropMessage({
      recipient: recipientKeypair.publicKey.toBytes(),
      amount: BigInt(claimAmount),
    });

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim()
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    expect(await sendTransaction(svm, recipientKeypair, [ed25519Ix, claimIx])).to.exist;
  });

  it("Fails when Ed25519 instruction is not first", async () => {
    const claimAmount = 1000000;

    const claimIx = await program.methods
      .claim()
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();


    const msg = new AirdropMessage({
      recipient: recipientKeypair.publicKey.toBytes(),
      amount: BigInt(claimAmount),
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

    const msg = new AirdropMessage({
      recipient: recipientKeypair.publicKey.toBytes(),
      amount: BigInt(claimAmount),
    });

    const ed25519Ix = createEd25519Instruction(
      invalidDistributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim()
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey, // But we expect the correct one
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
    const wrongRecipient = Keypair.generate();


    const msg = new AirdropMessage({
      recipient: wrongRecipient.publicKey.toBytes(),
      amount: BigInt(claimAmount),
    });

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    const claimIx = await program.methods
      .claim()
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
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


    const msg = new AirdropMessage({
      recipient: recipientKeypair.publicKey.toBytes(),
      amount: BigInt(claimAmount),
    });

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      Buffer.from(serialize(AirdropMessage.schema, msg))
    );

    // First claim instruction (valid)
    const claimIx1 = await program.methods
      .claim()
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
        instructionSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    // Second claim instruction (tries to reuse the same Ed25519)
    const claimIx2 = await program.methods
      .claim()
      .accountsPartial({
        recipient: recipientKeypair.publicKey,
        expectedDistributor: distributorKeypair.publicKey,
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

});