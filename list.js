import { ethers } from "ethers";
import { OpenSeaSDK, TokenStandard } from "@opensea/sdk";
import { RPC, SDK_CHAINS } from "./variables.js";
import { getWalletNFTsInCollection } from "./lib/openseaApi.js";
import { getEthUsdRate } from "./lib/walletMint.js";

const OPENSEA_API_KEY = process.env.API_KEY;

const ERC721_TRANSFER_ABI = [
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
];

function isCollectionWideOffer(offer) {
  return !offer.criteria?.trait;
}

function sortOffersByPrice(offers) {
  return [...offers].sort((a, b) => {
    const priceA = BigInt(a.price?.value ?? 0);
    const priceB = BigInt(b.price?.value ?? 0);
    return priceB > priceA ? 1 : priceB < priceA ? -1 : 0;
  });
}

async function getBestOfferForToken(openseaSDK, collectionSlug) {
  const allOffers = [];
  let cursor = undefined;

  do {
    const { offers, next } = await openseaSDK.api.getAllOffers(
      collectionSlug,
      100,
      cursor,
    );
    allOffers.push(...offers);
    cursor = next || undefined;
  } while (cursor);

  const collectionOffers = allOffers.filter(isCollectionWideOffer);

  const sorted = sortOffersByPrice(collectionOffers);
  const best = sorted[0];

  return best;
}

function toAssetList(tokens, extra = {}) {
  return tokens.map((token) => ({
    asset: {
      tokenAddress: token.contract,
      tokenId: token.tokenId,
      tokenStandard: TokenStandard.ERC721,
    },
    ...extra,
  }));
}

async function prepareWalletAndTokens(pk, provider, collectionSlug, chain) {
  const wallet = new ethers.Wallet(pk, provider);
  const tokensForCollection = await getWalletNFTsInCollection(
    wallet.address,
    collectionSlug,
    chain,
  );
  return { wallet, tokensForCollection };
}

async function prepareApprovedWallet(pk, provider, collectionSlug, chain) {
  const { wallet, tokensForCollection } = await prepareWalletAndTokens(
    pk,
    provider,
    collectionSlug,
    chain,
  );
  const openseaSDK = new OpenSeaSDK(wallet, {
    chain: SDK_CHAINS[chain],
    apiKey: OPENSEA_API_KEY,
  });

  await openseaSDK.batchApproveAssets({
    assets: toAssetList(tokensForCollection),
    fromAddress: wallet.address,
  });

  return { wallet, tokensForCollection, openseaSDK };
}

/**
 * Runs `handler` for each private key, collecting successes/failures in the
 * { success, fail } shape used throughout the bot. `handler` may return a
 * single { pk, txHash } entry or an array of them.
 */
async function processWallets(privateKeys, handler) {
  const success = [];
  const fail = [];

  for (const pk of privateKeys) {
    try {
      const result = await handler(pk);
      if (Array.isArray(result)) {
        success.push(...result);
      } else if (result) {
        success.push(result);
      }
    } catch (err) {
      console.error("Error", err);
      const error = err.shortMessage ? err.shortMessage : err.message;
      fail.push({ pk, err: error });
    }
  }

  return { success, fail };
}

export async function acceptBestOffer(privateKeys, collectionSlug, chain) {
  const provider = new ethers.JsonRpcProvider(RPC[chain]);

  return processWallets(privateKeys, async (pk) => {
    const { wallet, tokensForCollection, openseaSDK } =
      await prepareApprovedWallet(pk, provider, collectionSlug, chain);

    const results = [];
    for (const token of tokensForCollection) {
      const bestOffer = await getBestOfferForToken(openseaSDK, collectionSlug);

      const txHash = await openseaSDK.fulfillOrder({
        order: bestOffer,
        accountAddress: wallet.address,
        tokenId: token.tokenId,
        assetContractAddress: token.contract,
      });
      results.push({ pk, txHash });
    }
    return results;
  });
}

export async function transferNFTs(
  privateKeys,
  collectionSlug,
  chain,
  recipientAddress,
) {
  const provider = new ethers.JsonRpcProvider(RPC[chain]);

  return processWallets(privateKeys, async (pk) => {
    const { wallet, tokensForCollection } = await prepareWalletAndTokens(
      pk,
      provider,
      collectionSlug,
      chain,
    );

    const results = [];
    for (const token of tokensForCollection) {
      const nftContract = new ethers.Contract(
        token.contract,
        ERC721_TRANSFER_ABI,
        wallet,
      );
      const tx = await nftContract.safeTransferFrom(
        wallet.address,
        recipientAddress,
        token.tokenId,
      );
      const receipt = await tx.wait();
      if (receipt.status !== 1) {
        throw new Error(
          `Transfer reverted for token ${token.tokenId} (tx ${tx.hash})`,
        );
      }
      results.push({ pk, txHash: tx.hash });
    }
    return results;
  });
}

async function getFloorPrice(openseaSDK, collectionSlug) {
  const stats = await openseaSDK.api.getCollectionStats(collectionSlug);
  const floorPrice = stats?.total?.floorPrice;

  if (floorPrice === undefined || floorPrice === null) {
    throw new Error(
      `Could not read floor_price from stats for ${collectionSlug}`,
    );
  }

  return floorPrice;
}

async function resolveListingAmountEth(openseaSDK, collectionSlug, price) {
  if (price === "floor") {
    return getFloorPrice(openseaSDK, collectionSlug);
  }

  const numericPrice = Number(price);
  if (!price || Number.isNaN(numericPrice) || numericPrice <= 0) {
    throw new Error("Price must be a positive number, or 'floor'");
  }

  const ethUsdRate = await getEthUsdRate();
  return numericPrice / ethUsdRate;
}

export async function listNfts(privateKeys, collectionSlug, price, chain) {
  const provider = new ethers.JsonRpcProvider(RPC[chain]);

  return processWallets(privateKeys, async (pk) => {
    const { wallet, tokensForCollection, openseaSDK } =
      await prepareApprovedWallet(pk, provider, collectionSlug, chain);

    const amountEth = await resolveListingAmountEth(
      openseaSDK,
      collectionSlug,
      price,
    );

    const results = [];
    for (const token of tokensForCollection) {
      const listing = await openseaSDK.createListing({
        asset: {
          tokenId: token.tokenId,
          tokenAddress: token.contract,
        },
        accountAddress: wallet.address,
        amount: amountEth,
      });
      results.push({ pk, txHash: listing.orderHash });
    }
    return results;
  });
}
