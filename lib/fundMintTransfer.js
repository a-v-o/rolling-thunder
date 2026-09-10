import { ethers } from "ethers";
import { BASE_URL, RPC } from "../variables.js";
import { mintWithWallets, waitForMint } from "../mint.js";

const DEFAULT_FUNDING_AMOUNT = "0.0012";
const NFT_POLL_INTERVAL_MS = 2_000;
const NFT_POLL_TIMEOUT_MS = 120_000;

const erc721 = new ethers.Interface([
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
]);

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fundWallet(walletAddress, fundingWallet, amount) {
  const transaction = await fundingWallet.sendTransaction({
    to: walletAddress,
    value: amount,
  });
  const receipt = await transaction.wait();

  if (receipt.status !== 1) {
    throw new Error(`Funding transaction reverted for ${walletAddress}`);
  }

  return transaction.hash;
}

async function fundWallets(walletAddresses, privateKey, provider, amount) {
  const fundingWallet = new ethers.Wallet(privateKey, provider);
  const hashes = [];

  for (const address of walletAddresses) {
    hashes.push(await fundWallet(address, fundingWallet, amount));
  }

  return hashes;
}

async function getNFTsInCollection(walletAddress, collectionSlug, chain) {
  const tokens = [];
  let cursor = null;

  do {
    const url = new URL(
      `${BASE_URL}/chain/${chain}/account/${walletAddress}/nfts`,
    );
    url.searchParams.set("collection", collectionSlug);
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("next", cursor);

    const response = await fetch(url, {
      headers: { "X-API-KEY": process.env.API_KEY, accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(
        `Account NFTs request failed: ${response.status} ${await response.text()}`,
      );
    }

    const data = await response.json();
    for (const nft of data.nfts || []) {
      tokens.push({ tokenId: nft.identifier, contract: nft.contract });
    }
    cursor = data.next || null;
  } while (cursor);

  return tokens;
}

async function waitForNFTs(walletAddress, collectionSlug, chain) {
  const deadline = Date.now() + NFT_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const assets = await getNFTsInCollection(
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
) {
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(asset.contract, erc721, wallet);
  const transaction = await contract.safeTransferFrom(
    walletAddress,
    destination,
    asset.tokenId,
  );
  const receipt = await transaction.wait();

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
  );
  await sendMessage(`Funded ${fundingHashes.length} wallet(s).`);

  await waitForMint(mintTimeDate.toISOString(), slug, stage, sendMessage);
  const mintResults = await mintWithWallets(privateKeys, slug, quantity, chain);
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
        ),
      );
    }
  }

  return { mintResults, transfers, fundingHashes };
}
