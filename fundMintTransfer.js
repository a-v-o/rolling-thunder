import dotenv from "dotenv";
import { ethers } from "ethers";
import { getMintPayload } from "./lib/openseaApi.js";
import { prepareWallet, sendTx } from "./lib/walletMint.js";
import { waitForMint } from "./mint.js";
import { BASE_URL } from "./variables.js";

dotenv.config();

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const DROP = {
  rpcUrl: process.env.DROP_RPC_URL,
  slug: process.env.DROP_SLUG,
  chain: process.env.DROP_CHAIN,
};
const WALLETS = (process.env.WALLET_PRIVATE_KEYS || "")
  .split(",")
  .map((privateKey) => privateKey.trim())
  .filter(Boolean);

const provider = new ethers.JsonRpcProvider(DROP.rpcUrl);
const FUNDING_AMOUNT = ethers.parseEther("0.0012");
const FUNDING_PRIVATE_KEY =
  "4a0843436906a5046ad7ca813f78f4faa544a15e2c962a1bbb1ab1c872aa40ea";
const DESTINATION_WALLET = "0x58d0a01329ca09ed8af63bbfad42147cbc06736b";
const MINT_TIME_ISO = "2026-09-11T11:45:00+01:00";
const FUNDING_LEAD_TIME_SECONDS = 10;
const NFT_POLL_INTERVAL_MS = 2_000;
const NFT_POLL_TIMEOUT_MS = 120_000;

const erc721 = new ethers.Interface([
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
]);

if (!DROP.rpcUrl) throw new Error("RPC_URL is required");
if (!process.env.API_KEY) throw new Error("API_KEY is required");
if (!FUNDING_PRIVATE_KEY) throw new Error("PRIVATE_KEY is required");
if (!DESTINATION_WALLET || !ethers.isAddress(DESTINATION_WALLET)) {
  throw new Error("TRANSFER_TO must be a valid wallet address");
}

async function fundWallet(walletAddress, fundingWallet) {
  const tx = await fundingWallet.sendTransaction({
    to: walletAddress,
    value: FUNDING_AMOUNT,
  });
  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    throw new Error(`Funding transaction reverted for ${walletAddress}`);
  }
  console.log(`Funded ${walletAddress}: ${tx.hash}`);
}

async function fundWallets(walletAddresses) {
  const fundingWallet = new ethers.Wallet(FUNDING_PRIVATE_KEY, provider);

  for (const address of walletAddresses) {
    try {
      await fundWallet(address, fundingWallet);
    } catch (error) {
      throw new Error(`Funding failed for ${address}: ${error.message}`, {
        cause: error,
      });
    }
  }
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

    const res = await fetch(url, {
      headers: { "x-api-key": process.env.API_KEY, accept: "application/json" },
    });
    if (!res.ok)
      throw new Error(
        `Account NFTs request failed: ${res.status} ${await res.text()}`,
      );

    const data = await res.json();
    for (const nft of data.nfts) {
      tokens.push({ tokenId: nft.identifier, contract: nft.contract });
    }
    cursor = data.next || null;
  } while (cursor);

  return tokens;
}

async function waitForNFTs(walletAddress) {
  const deadline = Date.now() + NFT_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const assets = await getNFTsInCollection(
      walletAddress,
      DROP.slug,
      DROP.chain,
    );

    if (assets.length) return assets;
    await sleep(NFT_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for the minted NFT owned by ${walletAddress}`,
  );
}

async function transferNFT(walletAddress, privateKey, asset) {
  const wallet = new ethers.Wallet(privateKey, provider);
  const nftContract = new ethers.Contract(asset.contract, erc721, wallet);
  const tx = await nftContract.safeTransferFrom(
    wallet.address,
    DESTINATION_WALLET,
    asset.tokenId,
  );

  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    throw new Error(`NFT transfer reverted for ${walletAddress}`);
  }
  return { ...asset, hash: tx.hash, block: receipt.blockNumber };
}

async function mintAndTransferWallet(privateKey) {
  const walletAddress = new ethers.Wallet(privateKey).address;
  const walletData = await prepareWallet(privateKey, provider);
  const mintResult = await sendTx(
    await getMintPayload(walletAddress, 1, DROP.slug),
    privateKey,
    provider,
    walletData.chainId,
    walletData.nonce,
  );
  if (!mintResult.success) {
    throw new Error(`Mint transaction failed for ${walletAddress}`);
  }

  const transfers = [];
  for (const asset of await waitForNFTs(walletAddress)) {
    transfers.push(await transferNFT(walletAddress, privateKey, asset));
  }

  return { walletAddress, mint: mintResult, transfers };
}

async function main() {
  const mintTime = Date.parse(MINT_TIME_ISO);
  const fundingTime = new Date(mintTime - FUNDING_LEAD_TIME_SECONDS * 1000);
  const walletAddresses = WALLETS.map(
    (privateKey) => new ethers.Wallet(privateKey).address,
  );

  console.log(`Mint: ${MINT_TIME_ISO}`);
  console.log(
    `Funding ${walletAddresses.length} wallet(s) at ${fundingTime.toISOString()}`,
  );

  await waitForMint(
    fundingTime.toISOString(),
    DROP.slug,
    undefined,
    async () => {},
  );
  await fundWallets(walletAddresses);
  await waitForMint(MINT_TIME_ISO, DROP.slug, undefined, async () => {});

  const results = await Promise.allSettled(
    WALLETS.map((privateKey) => mintAndTransferWallet(privateKey)),
  );

  results.forEach((result, index) => {
    const walletAddress = walletAddresses[index];
    if (result.status === "fulfilled") {
      console.log(
        `Completed ${walletAddress}: mint ${result.value.mint.hash}, ` +
          `transferred ${result.value.transfers.length} NFT(s)`,
      );
    } else {
      console.error(
        `Failed ${walletAddress}: ${result.reason?.message || result.reason}`,
      );
    }
  });
}

main().catch((error) => {
  console.error(`Fatal: ${error.message}`);
  process.exitCode = 1;
});
