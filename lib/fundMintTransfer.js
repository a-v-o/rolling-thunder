import { ethers } from "ethers";
import { RPC } from "../variables.js";
import { getWalletNFTsInCollection } from "./openseaApi.js";
import { mintWithWallets, waitForMint } from "../mint.js";
import { getGasOverrides, sendAndWait } from "./walletMint.js";

const DEFAULT_FUNDING_AMOUNT = "0.0012";
const NFT_POLL_INTERVAL_MS = 2_000;
const NFT_POLL_TIMEOUT_MS = 120_000;

const erc721 = new ethers.Interface([
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
]);

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fundWallet(walletAddress, fundingWallet, amount, gasBudgetUsd) {
  const transactionData = {
    to: walletAddress,
    value: amount,
  };
  Object.assign(
    transactionData,
    await getGasOverrides(
      fundingWallet.provider,
      transactionData,
      gasBudgetUsd,
    ),
  );
  const { transaction, receipt } = await sendAndWait(
    fundingWallet,
    transactionData,
  );

  if (receipt.status !== 1) {
    throw new Error(`Funding transaction reverted for ${walletAddress}`);
  }

  return transaction.hash;
}

async function fundWallets(
  walletAddresses,
  privateKey,
  provider,
  amount,
  gasBudgetUsd,
) {
  const fundingWallet = new ethers.Wallet(privateKey, provider);
  const hashes = [];

  for (const address of walletAddresses) {
    hashes.push(await fundWallet(address, fundingWallet, amount, gasBudgetUsd));
  }

  return hashes;
}

async function waitForNFTs(walletAddress, collectionSlug, chain) {
  const deadline = Date.now() + NFT_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const assets = await getWalletNFTsInCollection(
      walletAddress,
      collectionSlug,
      chain,
    );
    if (assets.length > 0) return assets;
    await sleep(NFT_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for the minted NFT owned by ${walletAddress}`,
  );
}

async function transferNFT(
  walletAddress,
  privateKey,
  asset,
  destination,
  provider,
  gasBudgetUsd,
) {
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(asset.contract, erc721, wallet);
  const transfer = contract.getFunction("safeTransferFrom");
  const transactionData = await transfer.populateTransaction(
    walletAddress,
    destination,
    asset.tokenId,
  );
  Object.assign(
    transactionData,
    await getGasOverrides(provider, transactionData, gasBudgetUsd),
  );
  const { transaction, receipt } = await sendAndWait(wallet, transactionData);

  if (receipt.status !== 1) {
    throw new Error(`NFT transfer reverted for ${walletAddress}`);
  }

  return { ...asset, hash: transaction.hash, block: receipt.blockNumber };
}

export async function fundMintAndTransfer({
  privateKeys,
  fundingPrivateKey,
  destination,
  slug,
  quantity,
  chain,
  mintTime,
  stage,
  fundingLeadSeconds = 10,
  fundingAmount = DEFAULT_FUNDING_AMOUNT,
  gasBudgetUsd,
  sendMessage = async () => {},
}) {
  if (!RPC[chain]) throw new Error(`No RPC configured for chain: ${chain}`);
  if (!ethers.isAddress(destination))
    throw new Error("Destination must be a valid wallet address");

  const provider = new ethers.JsonRpcProvider(RPC[chain]);
  const walletAddresses = privateKeys.map(
    (privateKey) => new ethers.Wallet(privateKey).address,
  );
  const mintTimeDate = new Date(mintTime);
  if (Number.isNaN(mintTimeDate.getTime()))
    throw new Error("Mint time is invalid");

  const fundingTime = new Date(
    mintTimeDate.getTime() - fundingLeadSeconds * 1000,
  );
  await sendMessage(
    `Waiting until ${fundingTime.toISOString()} to fund ${walletAddresses.length} wallet(s).`,
  );
  await waitForMint(fundingTime.toISOString(), slug, undefined, sendMessage);

  const fundingHashes = await fundWallets(
    walletAddresses,
    fundingPrivateKey,
    provider,
    ethers.parseEther(String(fundingAmount)),
    gasBudgetUsd,
  );
  await sendMessage(`Funded ${fundingHashes.length} wallet(s).`);

  await waitForMint(mintTimeDate.toISOString(), slug, stage, sendMessage);
  const mintResults = await mintWithWallets(
    privateKeys,
    slug,
    quantity,
    chain,
    undefined,
    stage,
    gasBudgetUsd,
  );
  const failedMints = mintResults.filter((result) => !result.success);
  if (failedMints.length === mintResults.length) {
    throw new Error("All mint transactions failed");
  }

  const transfers = [];
  for (const [index, result] of mintResults.entries()) {
    if (!result.success) continue;
    const assets = await waitForNFTs(walletAddresses[index], slug, chain);
    for (const asset of assets) {
      transfers.push(
        await transferNFT(
          walletAddresses[index],
          privateKeys[index],
          asset,
          destination,
          provider,
          gasBudgetUsd,
        ),
      );
    }
  }

  return { mintResults, transfers, fundingHashes };
}
