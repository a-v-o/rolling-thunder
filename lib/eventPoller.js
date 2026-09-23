import { ethers } from "ethers";
import { OpenSeaSDK, AssetEventType } from "@opensea/sdk";
import { RPC } from "../variables.js";
import {
  getTrackedWallets,
  getLastEventTimestamp,
  setLastEventTimestamp,
} from "./walletStorage.js";
import { getDrop } from "./openseaApi.js";

const OPENSEA_API_KEY = process.env.API_KEY;

export function filterEventsForChat(wallet, chatId, events) {
  if (!Array.isArray(events) || events.length === 0) return [];

  const allowedChains = new Set();
  const subscriptions = wallet?.subscriptions ?? [];

  for (const subscription of subscriptions) {
    const matchesChat =
      chatId === null || chatId === undefined
        ? true
        : String(subscription.chatId) === String(chatId);

    if (!matchesChat) continue;
    for (const chain of subscription.chains ?? []) {
      allowedChains.add(chain);
    }
  }

  if (allowedChains.size === 0) return [];
  return events.filter((event) => allowedChains.has(event.chain));
}

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

export async function pollWallet(walletAddress) {
  const rpcUrl = RPC.ethereum;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const lastTimestamp = await getLastEventTimestamp(walletAddress);

  const sdk = new OpenSeaSDK(provider, {
    apiKey: OPENSEA_API_KEY,
  });

  const params = { eventType: AssetEventType.MINT, limit: 50 };
  if (lastTimestamp) params.after = lastTimestamp + 5;

  const response = await sdk.api.getEventsByAccount(walletAddress, params);
  const allEvents = response.assetEvents ?? [];
  // Only one notification per collection is needed for each poll.
  const seen = new Set();
  const uniqueEvents = allEvents.filter((event) => {
    const collection = event.nft?.collection;
    if (!collection || seen.has(collection)) return false;
    seen.add(collection);
    return true;
  });

  const freeMints = [];
  for (const event of uniqueEvents) {
    if (await isFreeMint(event.nft.collection)) {
      freeMints.push(event);
    }
  }

  const latestTimestamp = allEvents
    .map((event) => Number(event.eventTimestamp))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  if (latestTimestamp !== undefined)
    await setLastEventTimestamp(walletAddress, latestTimestamp);

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
  const trackedWallets = await getTrackedWallets();

  if (trackedWallets.length === 0) return [];

  const results = await Promise.allSettled(
    trackedWallets.map((wallet) => pollWallet(wallet.address)),
  );

  const allEvents = [];
  const seen = new Set();

  for (const [index, result] of results.entries()) {
    if (result.status !== "fulfilled") {
      console.error(
        `Poll failed for wallet: ${trackedWallets[index].address} ${result.reason?.message}`,
      );
      continue;
    }

    const wallet = trackedWallets[index];
    const walletEvents =
      chatId === null || chatId === undefined
        ? wallet.subscriptions.flatMap((subscription) => {
            const chains = new Set(subscription.chains ?? []);
            return result.value
              .filter((event) => chains.has(event.chain))
              .map((event) => ({ chatId: subscription.chatId, event }));
          })
        : filterEventsForChat(wallet, chatId, result.value).map((event) => ({
            chatId: String(chatId),
            event,
          }));

    for (const entry of walletEvents) {
      const key = `${entry.chatId}-${entry.event.collectionSlug}-${entry.event.chain}-${entry.event.eventTimestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allEvents.push(entry);
    }
  }

  return allEvents;
}
