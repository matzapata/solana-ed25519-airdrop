import { AnchorError } from "@coral-xyz/anchor";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { Keypair } from "@solana/web3.js";
import { Transaction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

export const sendTransaction = async (
    svm: LiteSVM,
    signer: Keypair,
    instructions: anchor.web3.TransactionInstruction[],
  ) => {
    const tx = new Transaction().add(...instructions);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = signer.publicKey;
    tx.sign(signer);
    const sig = await svm.sendTransaction(tx);
    if (sig instanceof FailedTransactionMetadata) {
      const error = AnchorError.parse(sig.meta().logs());
      if (error) {
        throw error;
      }
  
      throw new Error('Unknown error: ' + sig.toString());
    }
  
    return sig;
  };