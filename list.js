import { ethers } from "ethers";
import { OpenSeaSDK, TokenStandard } from "@opensea/sdk";
import { BASE_URL, RPC, SDK_CHAINS } from "./variables.js";

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

async function getWalletTokensInCollection(
  walletAddress,
  collectionSlug,
  chain,
) {
  const tokenIds = [];
  let cursor = null;

  do {
    const url = new URL(
      `${BASE_URL}/chain/${chain}/account/${walletAddress}/nfts`,
    );
    url.searchParams.set("collection", collectionSlug);
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("next", cursor);

    const res = await fetch(url, {
      headers: { "x-api-key": OPENSEA_API_KEY, accept: "application/json" },
    });
    if (!res.ok)
      throw new Error(
        `Account NFTs request failed: ${res.status} ${await res.text()}`,
      );

    const data = await res.json();
    for (const nft of data.nfts) {
      tokenIds.push({ tokenId: nft.identifier, contract: nft.contract });
    }
    cursor = data.next || null;
  } while (cursor);

  return tokenIds;
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
  const tokensForCollection = await getWalletTokensInCollection(
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

async function getEthUsdRate() {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
  );
  if (!res.ok) throw new Error(`Failed to fetch ETH/USD rate: ${res.status}`);
  const data = await res.json();
  const rate = data?.ethereum?.usd;
  if (!rate) throw new Error("ETH/USD rate not found in response");
  return rate;
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
