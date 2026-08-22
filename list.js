import { ethers } from "ethers";
import { OpenSeaSDK, TokenStandard } from "@opensea/sdk";

import { BASE_URL, RPC, SDK_CHAINS } from "./variables.js";

const OPENSEA_API_KEY = process.env.API_KEY;

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

export async function acceptBestOffer(privateKeys, collectionSlug, chain) {
  const rpcURL = RPC[chain];
  const provider = new ethers.JsonRpcProvider(rpcURL);

  const success = [];
  const fail = [];

  for (const pk of privateKeys) {
    try {
      const wallet = new ethers.Wallet(pk, provider);
      const tokensForCollection = await getWalletTokensInCollection(
        wallet.address,
        collectionSlug,
        chain,
      );
      const sdkChain = SDK_CHAINS[chain];
      const openseaSDK = new OpenSeaSDK(wallet, {
        chain: sdkChain,
        apiKey: OPENSEA_API_KEY,
      });

      const assets = tokensForCollection.map((token) => ({
        asset: {
          tokenAddress: token.contract,
          tokenId: token.tokenId,
          tokenStandard: TokenStandard.ERC721,
        },
      }));

      await openseaSDK.batchApproveAssets({
        assets: assets,
        fromAddress: wallet.address,
      });

      for (const token of tokensForCollection) {
        const bestOffer = await getBestOfferForToken(
          openseaSDK,
          collectionSlug,
        );

        const txHash = await openseaSDK.fulfillOrder({
          order: bestOffer,
          accountAddress: wallet.address,
          tokenId: token.tokenId,
          assetContractAddress: token.contract,
        });
        success.push({ pk, txHash });
      }
    } catch (err) {
      console.error(err);
      const error = err.shortMessage ? err.shortMessage : err.message;
      fail.push({ pk, err: error });
    }
  }
  return { success, fail };
}

export async function transferNFTs(
  privateKeys,
  collectionSlug,
  chain,
  recipientAddress,
) {
  const rpcURL = RPC[chain];
  const provider = new ethers.JsonRpcProvider(rpcURL);

  const success = [];
  const fail = [];

  for (const pk of privateKeys) {
    try {
      const wallet = new ethers.Wallet(pk, provider);
      const tokensForCollection = await getWalletTokensInCollection(
        wallet.address,
        collectionSlug,
        chain,
      );
      const sdkChain = SDK_CHAINS[chain];
      const openseaSDK = new OpenSeaSDK(wallet, {
        chain: sdkChain,
        apiKey: OPENSEA_API_KEY,
      });

      const assetsToApprove = tokensForCollection.map((token) => ({
        asset: {
          tokenAddress: token.contract,
          tokenId: token.tokenId,
          tokenStandard: TokenStandard.ERC721,
        },
      }));

      const assetsToTransfer = tokensForCollection.map((token) => ({
        asset: {
          tokenAddress: token.contract,
          tokenId: token.tokenId,
          tokenStandard: TokenStandard.ERC721,
        },
        toAddress: recipientAddress,
      }));

      const approvalHash = await openseaSDK.batchApproveAssets({
        assets: assetsToTransfer,
        fromAddress: wallet.address,
      });

      console.log(assetsToTransfer)

      console.log(approvalHash)

      const txHash = await openseaSDK.bulkTransfer({
        assets: assetsToTransfer,
        fromAddress: wallet.address,
      });
      success.push({ pk, txHash });
    } catch (err) {
      console.error(err);
      const error = err.shortMessage ? err.shortMessage : err.message;
      fail.push({ pk, err: error });
    }
  }
  return { success, fail };
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

export async function listNfts(privateKeys, collectionSlug, price, chain) {
  const rpcURL = RPC[chain];
  const provider = new ethers.JsonRpcProvider(rpcURL);

  const success = [];
  const fail = [];

  for (const pk of privateKeys) {
    try {
      const wallet = new ethers.Wallet(pk, provider);
      const tokensForCollection = await getWalletTokensInCollection(
        wallet.address,
        collectionSlug,
        chain,
      );
      const sdkChain = SDK_CHAINS[chain];
      const openseaSDK = new OpenSeaSDK(wallet, {
        chain: sdkChain,
        apiKey: OPENSEA_API_KEY,
      });

      let amountEth;

      if (price === "floor") {
        amountEth = await getFloorPrice(openseaSDK, collectionSlug);
      } else {
        if (!price || price <= 0) {
          throw new Error("Price must be provided and must be positive");
        }
        const ethUsdRate = await getEthUsdRate();
        amountEth = price / ethUsdRate;
      }

      for (const token of tokensForCollection) {
        const listing = await openseaSDK.createListing({
          asset: {
            tokenId: token.tokenId,
            tokenAddress: token.contract,
          },
          accountAddress: wallet.address,
          amount: amountEth,
        });

        success.push({ pk, txHash: listing.orderHash });
      }
    } catch (err) {
      console.error(err);
      const error = err.shortMessage ? err.shortMessage : err.message;
      fail.push({ pk, err: error });
    }
  }
  return { success, fail };
}
