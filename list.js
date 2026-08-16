import { ethers } from "ethers";
import { OpenSeaSDK, Chain, OrderSide } from "@opensea/sdk";

import { BASE_URL, RPC, SDK_CHAINS } from "./variables.js";

const OPENSEA_API_KEY = process.env.API_KEY;

async function openseaGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "x-api-key": OPENSEA_API_KEY, accept: "application/json" },
  });
  if (!res.ok)
    throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

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
      for (const token of tokensForCollection) {
        const bestOffer = await getBestOfferForToken(
          openseaSDK,
          collectionSlug,
        );
        try {
          const txHash = await openseaSDK.fulfillOrder({
            order: bestOffer,
            accountAddress: wallet.address,
            tokenId: token.tokenId,
            assetContractAddress: token.contract,
          });
          success.push({ pk, txHash });
        } catch (err) {
          console.error(err.message);
          fail.push({ pk, err: err.shortMessage });
        }
      }
    } catch (err) {
      console.error(err);
      fail.push({ pk, err: err.shortMessage });
    }
  }
  return { success, fail };
}

// await acceptBestOffer(
//   ["2b3fa300ee1cf9354c3531c2d3c7c79d289ae3e9fea9a8cd92aeec563ba0420d"],
//   "miu-hoodies",
//   "robinhood",
// );
