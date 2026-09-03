import { ethers } from "ethers";
import { OpenSeaSDK, AssetEventType } from "@opensea/sdk";
import { RPC, SDK_CHAINS } from "../variables.js";
import {
  getTrackedWallets,
  getLastEventTimestamp,
  setLastEventTimestamp,
} from "./walletStorage.js";
import { getDrop } from "../mint.js";

const OPENSEA_API_KEY = process.env.API_KEY;

/**
 * Check if a drop is a free mint by fetching its price.
 * Returns true if the drop price is 0 or unavailable.
 */
async function isFreeMint(collectionSlug) {
  try {
    const drop = await getDrop(collectionSlug);
    const price = drop.active_stage.price;
    return Number(price) === 0;
  } catch {
    return false;
  }
}

export async function pollWallet(chatId, walletAddress, chain) {
  const rpcUrl = RPC[chain];
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const lastTimestamp = await getLastEventTimestamp(chatId, walletAddress);

  const sdk = new OpenSeaSDK(provider, {
    chain: SDK_CHAINS[chain],
    apiKey: OPENSEA_API_KEY,
  });

  const params = { eventType: AssetEventType.MINT, limit: 50, chain: chain };
  // On first fetch (no timestamp yet), get latest events.
  // On subsequent polls, only fetch events after the last seen timestamp.
  if (lastTimestamp) {
    params.after = lastTimestamp;
  }

  const response = await sdk.api.getEventsByAccount(walletAddress, params);
  const allEvents = response.assetEvents;
  // Deduplicate by collection slug - keep only the first event per collection
  const seen = new Set();
  const uniqueEvents = allEvents.filter((event) => {
    if (!event.nft.collection || seen.has(event.nft.collection)) return false;
    seen.add(event.nft.collection);
    return true;
  });

  console.log(uniqueEvents)

  // Filter to only free mints by checking drop price
  const freeMints = [];
  for (const event of uniqueEvents) {
    if (await isFreeMint(event.nft.collection)) {
      freeMints.push(event);
    }
  }

  console.log(freeMints)

  // Update the last event timestamp to the most recent event's timestamp
  if (freeMints.length > 0) {
    const latestTimestamp = freeMints
      .map((e) => e.eventTimestamp)
      .sort((a, b) => b - a)[0];
    if (latestTimestamp) {
      await setLastEventTimestamp(chatId, walletAddress, latestTimestamp);
    }
  }

  return freeMints.map((event) => ({
    eventType: event.eventType,
    collectionSlug: event.nft.collection,
    chain: event.chain,
    fromAddress: event.fromAddress,
    toAddress: event.toAddress,
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
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      allEvents.push(...result.value);
    } else {
      console.error(
        `Poll failed for wallet: ${trackedWallets[index].address} ${result.reason?.message}`,
      );
    }
  }

  return allEvents;
}
