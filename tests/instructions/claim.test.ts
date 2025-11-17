import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Airdrop } from "../../target/types/airdrop";
import { PublicKey, Keypair, TransactionInstruction, Ed25519Program } from "@solana/web3.js";
import { expect } from "chai";
import * as nacl from "tweetnacl";
import { LiteSVM, } from "litesvm";
import { fromWorkspace, LiteSVMProvider } from 'anchor-litesvm';
import { sendTransaction } from "../utils/svm";
import { serialize } from "borsh";

// Define the message structure for Borsh serialization
class AirdropMessage {
  recipient: Uint8Array;
  amount: bigint;

  constructor(fields: { recipient: Uint8Array; amount: bigint }) {
    this.recipient = fields.recipient;
    this.amount = fields.amount;
  }

  // Borsh schema definition
  static schema = {
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


  function createEd25519Instruction(
    distributorKeypair: Keypair,
    recipientPubkey: PublicKey,
    amount: number
  ): TransactionInstruction {
    // Create the message instance
    const msg = new AirdropMessage({
      recipient: recipientPubkey.toBytes(),
      amount: BigInt(amount),
    });

    // Serialize using Borsh
    const message = Buffer.from(serialize(AirdropMessage.schema, msg));

    // Sign the message with distributor
    const signature = nacl.sign.detached(message, distributorKeypair.secretKey);

    // Use the helper to build the instruction
    return Ed25519Program.createInstructionWithPublicKey({
      publicKey: distributorKeypair.publicKey.toBytes(),
      message,
      signature,
    });
  }

  it("Successfully claims airdrop with valid signature", async () => {
    const claimAmount = 1000000;

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      recipientKeypair.publicKey,
      claimAmount
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

    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      recipientKeypair.publicKey,
      claimAmount
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

    // Create Ed25519 instruction with wrong distributor
    const ed25519Ix = createEd25519Instruction(
      invalidDistributorKeypair, // Wrong distributor signs
      recipientKeypair.publicKey,
      claimAmount
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

    // Create Ed25519 instruction with wrong recipient in message
    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      wrongRecipient.publicKey, // Wrong recipient in signed message
      claimAmount
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

    // Create a single Ed25519 instruction
    const ed25519Ix = createEd25519Instruction(
      distributorKeypair,
      recipientKeypair.publicKey,
      claimAmount
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