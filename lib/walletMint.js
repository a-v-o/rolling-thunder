import { ethers } from "ethers";
import { getMintPayload } from "./openseaApi.js";
import { RPC } from "../variables.js";

let cachedEthUsdRate;
let cachedEthUsdRateAt = 0;

export async function getEthUsdRate() {
  if (cachedEthUsdRate && Date.now() - cachedEthUsdRateAt < 30_000) {
    return cachedEthUsdRate;
  }

  const response = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch ETH/USD rate: ${response.status}`);
  }
  const data = await response.json();
  const rate = data?.ethereum?.usd;
  if (!rate) throw new Error("ETH/USD rate not found in response");

  cachedEthUsdRate = Number(rate);
  cachedEthUsdRateAt = Date.now();
  return cachedEthUsdRate;
}

export async function getGasOverrides(provider, transaction, gasBudgetUsd) {
  if (gasBudgetUsd == null) return {};

  const budget = Number(gasBudgetUsd);
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error("Gas budget must be a positive USD amount.");
  }

  const [gasLimit, feeData, latestBlock, ethUsdRate] = await Promise.all([
    provider.estimateGas(transaction),
    provider.getFeeData(),
    provider.getBlock("latest"),
    getEthUsdRate(),
  ]);
  const budgetWei = ethers.parseUnits(
    (budget / ethUsdRate).toFixed(18),
    "ether",
  );
  const baseFee = latestBlock?.baseFeePerGas ?? feeData.gasPrice ?? 0n;
  const totalFeePerGas = budgetWei / gasLimit;

  if (totalFeePerGas <= baseFee) {
    throw new Error(
      `Gas budget is below the current base fee. Increase it above $${(Number(ethers.formatEther(baseFee * gasLimit)) * ethUsdRate).toFixed(2)}.`,
    );
  }

  const maxPriorityFeePerGas = totalFeePerGas - baseFee;
  return {
    gasLimit,
    maxPriorityFeePerGas,
    maxFeePerGas: totalFeePerGas,
  };
}

export async function sendAndWait(wallet, transactionData) {
  const transaction = await wallet.sendTransaction(transactionData);
  const receipt = await transaction.wait();
  return { transaction, receipt };
}

export async function sendTx(
  txData,
  privateKey,
  provider,
  chainId,
  nonce,
  gasBudgetUsd,
) {
  const wallet = new ethers.Wallet(privateKey, provider);
  const tx = {
    to: txData.to,
    data: txData.data,
    value: BigInt(txData.value || "0"),
    chainId,
    nonce,
  };
  Object.assign(tx, await getGasOverrides(provider, tx, gasBudgetUsd));

  const { transaction: sent, receipt } = await sendAndWait(wallet, tx);

  return {
    privateKey,
    address: wallet.address,
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

export async function mintWithWallet(
  wallet,
  quantity,
  slug,
  provider,
  gasBudgetUsd,
) {
  const walletAddress = new ethers.Wallet(wallet.privateKey).address;

  try {
    const txData = await getMintPayload(walletAddress, quantity, slug);
    return await sendTx(
      txData,
      wallet.privateKey,
      provider,
      wallet.chainId,
      wallet.nonce,
      gasBudgetUsd,
    );
  } catch (error) {
    return {
      privateKey: wallet.privateKey,
      address: walletAddress,
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
