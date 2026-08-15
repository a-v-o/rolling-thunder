import { ethers } from "ethers";
import { OpenSeaSDK, Chain, OrderSide } from "@opensea/sdk";

import { BASE_URL, SDK_CHAINS } from "./variables.js";

const OPENSEA_API_KEY = process.env.API_KEY;
const RPC_URL = process.env.RPC_URL;

const provider = new ethers.JsonRpcProvider(RPC_URL);

const openseaSDK = new OpenSeaSDK(provider, {
  //   chain: Chain.Mainnet,
  //   chain: Chain.Base,
  //   chain: Chain.Robinhood,
  chain: Chain.Robinhood,
  apiKey: OPENSEA_API_KEY,
});

async function openseaGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "x-api-key": OPENSEA_API_KEY, accept: "application/json" },
  });
  if (!res.ok)
    throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getWalletTokensInCollection(walletAddress, collectionSlug) {
  const tokenIds = [];
  let cursor = null;

  do {
    const url = new URL(
      `${BASE_URL}/chain/${DROP.chain}/account/${walletAddress}/nfts`,
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

async function getBestOfferForToken(collectionSlug) {
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

export async function acceptBestOffer(
  privateKeys,
  collectionSlug,
  chain,
  maxAttempts = 3,
  baseDelayMs = 1000,
) {
  const results = [];

  for (const pk of privateKeys) {
    let walletSucceeded = false;

    for (
      let attempt = 1;
      attempt <= maxAttempts && !walletSucceeded;
      attempt++
    ) {
      try {
        const wallet = new ethers.Wallet(pk, provider);
        const tokensForCollection = await getWalletTokensInCollection(
          wallet.address,
          collectionSlug,
        );

        const sdkChain = SDK_CHAINS[chain];

        const openseaSDK = new OpenSeaSDK(wallet, {
          chain: sdkChain,
          apiKey: OPENSEA_API_KEY,
        });

        for (const token of tokensForCollection) {
          const bestOffer = await getBestOfferForToken(collectionSlug);

          if (!bestOffer) {
            results.push({
              pk,
              tokenId: token.tokenId,
              reason: "no offer available",
            });
            continue;
          }

          const txHash = await openseaSDK.fulfillOrder({
            order: bestOffer,
            accountAddress: wallet.address,
            tokenId: token.tokenId,
            assetContractAddress: token.contract,
          });

          results.push({ pk, tokenId: token.tokenId, txHash });
        }

        walletSucceeded = true;
      } catch (error) {
        const isLastAttempt = attempt === maxAttempts;

        if (isLastAttempt) {
          results.push({ pk, reason: error.message });
        } else {
          const delay = baseDelayMs;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }

  return results;
}
