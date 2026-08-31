import { ethers } from "ethers";
import { OpenSeaSDK, AssetEventType } from "@opensea/sdk";
import { RPC, SDK_CHAINS } from "../variables.js";
import {
  getTrackedWallets,
  getLastCursor,
  setLastCursor,
} from "./walletStorage.js";

const OPENSEA_API_KEY = process.env.API_KEY;

export async function pollWallet(chatId, walletAddress, chain) {
  const rpcUrl = RPC[chain];
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const lastCursor = await getLastCursor(chatId, walletAddress);

  const sdk = new OpenSeaSDK(provider, {
    chain: SDK_CHAINS[chain],
    apiKey: OPENSEA_API_KEY,
  });

  const params = { eventType: AssetEventType.MINT, limit: 50 };
  if (lastCursor) params.next = lastCursor;

  const response = await sdk.api.getEventsByAccount(walletAddress, params);

  const allEvents = response.assetEvents || [];
  const newCursor = response.next || lastCursor;

  const freeMints = allEvents.filter(
    (event) =>
      (!event.price || Number(event.price?.value ?? event.price) === 0) &&
      (!event.chain || event.chain === chain),
  );

  if (freeMints.length > 0) {
    await setLastCursor(chatId, walletAddress, newCursor);
  }

  return freeMints.map((event) => ({
    eventType: event.eventType,
    collectionSlug: event.collectionSlug,
    contractAddress: event.contractAddress,
    tokenId: event.tokenId,
    chain,
    fromAddress: event.fromAddress,
    toAddress: event.toAddress,
    price: event.price,
    transactionHash: event.transactionHash,
    eventTimestamp: event.eventTimestamp,
  }));
}

export async function pollAllTrackedWallets(chatId) {
  const trackedWallets = await getTrackedWallets(chatId);

  if (trackedWallets.length === 0) return [];

  const results = await Promise.allSettled(
    trackedWallets.map((w) => pollWallet(chatId, w.address, w.chain)),
  );

  const allEvents = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      allEvents.push(...result.value);
    } else {
      console.error("Poll failed for wallet:", result.reason?.message);
    }
  }

  return allEvents;
}
