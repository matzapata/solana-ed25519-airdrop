import { Keypair, TransactionInstruction, Ed25519Program } from "@solana/web3.js";
import * as nacl from "tweetnacl";

export function createEd25519Instruction(
    signer: Keypair,
    message: Buffer,
): TransactionInstruction {
    // Sign the message with signer
    const signature = nacl.sign.detached(message, signer.secretKey);

    // Use the helper to build the instruction
    return Ed25519Program.createInstructionWithPublicKey({
        publicKey: signer.publicKey.toBytes(),
        message,
        signature,
    });
}
