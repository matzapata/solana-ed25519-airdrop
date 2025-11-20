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

/**
 * Creates an Ed25519 instruction with multiple signatures for the same message
 * Format: [count: u8, padding: u8, ...signature_entries: 14 bytes each, ...signatures, ...pubkeys, message]
 * Each signature entry: [sig_offset: u16, sig_ix_idx: u16, pk_offset: u16, pk_ix_idx: u16, msg_offset: u16, msg_size: u16, msg_ix_idx: u16]
 */
export function createEd25519InstructionWithMultipleSigners(
    signers: Keypair[],
    message: Buffer,
): TransactionInstruction {
    if (signers.length === 0) {
        throw new Error("At least one signer is required");
    }
    if (signers.length > 255) {
        throw new Error("Maximum 255 signers supported");
    }

    const SIG_LEN = 64;
    const PUBKEY_LEN = 32;
    const HEADER_LEN = 2; // count + padding
    const SIG_ENTRY_LEN = 14; // 7 u16 values per signature entry
    const THIS_IX = 0xFFFF; // u16::MAX - sentinel for "current instruction"

    // Sign the message with all signers
    const signatures = signers.map(signer => nacl.sign.detached(message, signer.secretKey));
    const publicKeys = signers.map(signer => signer.publicKey.toBytes());

    // Calculate the header length: 2 bytes (count + padding) + 14 bytes per signature entry
    const minHeaderLen = HEADER_LEN + (signers.length * SIG_ENTRY_LEN);
    
    // Calculate offsets for signatures and public keys
    // Layout: [header][sig1][sig2]...[sigN][pk1][pk2]...[pkN][message]
    const signatureOffsets: number[] = [];
    const publicKeyOffsets: number[] = [];
    
    let offset = minHeaderLen;
    
    // All signatures come first
    for (let i = 0; i < signers.length; i++) {
        signatureOffsets.push(offset);
        offset += SIG_LEN;
    }
    
    // Then all public keys
    for (let i = 0; i < signers.length; i++) {
        publicKeyOffsets.push(offset);
        offset += PUBKEY_LEN;
    }
    
    // Message comes last (same for all signatures)
    const messageOffset = offset;

    // Build the instruction data
    const data: number[] = [];

    // Header: count and padding
    data.push(signers.length); // count
    data.push(0); // padding

    // Signature entries (7 u16 values each)
    for (let i = 0; i < signers.length; i++) {
        // signature_offset: u16 (little-endian)
        const sigOffset = signatureOffsets[i];
        data.push(sigOffset & 0xFF);
        data.push((sigOffset >> 8) & 0xFF);

        // signature_instruction_index: u16 (THIS_IX = 0xFFFF)
        data.push(0xFF);
        data.push(0xFF);

        // public_key_offset: u16 (little-endian)
        const pkOffset = publicKeyOffsets[i];
        data.push(pkOffset & 0xFF);
        data.push((pkOffset >> 8) & 0xFF);

        // public_key_instruction_index: u16 (THIS_IX = 0xFFFF)
        data.push(0xFF);
        data.push(0xFF);

        // message_data_offset: u16 (little-endian)
        data.push(messageOffset & 0xFF);
        data.push((messageOffset >> 8) & 0xFF);

        // message_data_size: u16 (little-endian)
        data.push(message.length & 0xFF);
        data.push((message.length >> 8) & 0xFF);

        // message_instruction_index: u16 (THIS_IX = 0xFFFF)
        data.push(0xFF);
        data.push(0xFF);
    }

    // Append all signatures
    for (const sig of signatures) {
        data.push(...Array.from(sig));
    }

    // Append all public keys
    for (const pk of publicKeys) {
        data.push(...Array.from(pk));
    }

    // Append message (once, shared by all signatures)
    data.push(...Array.from(message));

    return new TransactionInstruction({
        programId: Ed25519Program.programId,
        keys: [],
        data: Buffer.from(data),
    });
}
