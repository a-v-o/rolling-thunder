import { ethers } from "ethers";
import { getMintPayload } from "./openseaApi.js";
import { RPC } from "../variables.js";

export async function sendTx(txData, privateKey, provider, chainId, nonce) {
  const wallet = new ethers.Wallet(privateKey, provider);
  const tx = {
    to: txData.to,
    data: txData.data,
    value: BigInt(txData.value || "0"),
    chainId,
    nonce,
  };

  const sent = await wallet.sendTransaction(tx);
  const receipt = await sent.wait();

  return {
    privateKey,
    success: receipt.status === 1,
    hash: sent.hash,
    block: receipt.blockNumber,
  };
}

export async function fetchChainIdAndNonce(walletAddress, provider) {
  const [network, nonce] = await Promise.all([
    provider.getNetwork(),
    provider.getTransactionCount(walletAddress),
  ]);
  return { chainId: Number(network.chainId), nonce };
}

export async function prepareWallet(privateKey, provider) {
  const walletAddress = new ethers.Wallet(privateKey).address;
  const { chainId, nonce } = await fetchChainIdAndNonce(
    walletAddress,
    provider,
  );
  return { privateKey, chainId, nonce };
}

export async function mintWithWallet(wallet, quantity, slug, provider) {
  const walletAddress = new ethers.Wallet(wallet.privateKey).address;

  try {
    const txData = await getMintPayload(walletAddress, quantity, slug);
    return await sendTx(
      txData,
      wallet.privateKey,
      provider,
      wallet.chainId,
      wallet.nonce,
    );
  } catch (error) {
    return {
      privateKey: wallet.privateKey,
      success: false,
      error: error.message,
    };
  }
}

export async function prepareMintWallets(privateKeys, chain) {
  const provider = new ethers.JsonRpcProvider(RPC[chain]);
  const results = await Promise.allSettled(
    privateKeys.map((privateKey) => prepareWallet(privateKey, provider)),
  );

  return {
    provider,
    entries: results.map((result, index) =>
      result.status === "fulfilled"
        ? { ok: true, wallet: result.value }
        : {
            ok: false,
            privateKey: privateKeys[index],
            error: result.reason?.message || String(result.reason),
          },
    ),
  };
}
