import { ethers } from "ethers";
import { RPC } from "./variables.js";
import { pollAllTrackedWallets } from "./lib/eventPoller.js";
import { getBotWallets } from "./lib/walletStorage.js";
import { getDecryptedKeys } from "./lib/utils.js";
import { getMintPayload, sendTx, prepareWallet, getDrop } from "./mint.js";
import { bot } from "./bot.js";
import { agenda } from "./agenda.js";

/**
 * Determine the mint quantity for a drop. Uses maxMintablePerWallet from
 * the drop data, capped by the remaining supply. Falls back to 1 if the
 * drop data is unavailable.
 */
async function resolveMintQuantity(collectionSlug) {
  try {
    const drop = await getDrop(collectionSlug);
    const maxPerWallet = drop?.max_mintable_per_wallet ?? 1;
    const supplyLeft =
      drop?.supply_left ?? drop?.supply ?? Number.MAX_SAFE_INTEGER;
    return Math.min(maxPerWallet, supplyLeft);
  } catch {
    return 1;
  }
}

export async function triggerReplayMint(chatId, event) {
  const { collectionSlug, chain } = event;

  const botWallets = await getBotWallets(chatId);
  if (!botWallets || botWallets.length === 0) {
    await bot.api.sendMessage(
      chatId,
      "No bot wallets configured. Skipping mint.",
    );
    return;
  }

  const encryptedKeys = botWallets.map((w) => w.encryptedKey);
  const privateKeys = getDecryptedKeys(encryptedKeys);

  const quantity = await resolveMintQuantity(collectionSlug);

  await bot.api.sendMessage(
    chatId,
    `Free mint detected on ${collectionSlug}! Replaying with ${privateKeys.length} wallet(s), ${quantity} per wallet...`,
  );

  const rpcUrl = RPC[chain];
  if (!rpcUrl) {
    await bot.api.sendMessage(chatId, `Unsupported chain: ${chain}`);
    return;
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const results = [];

  for (const pk of privateKeys) {
    try {
      const walletData = await prepareWallet(pk, provider);
      const txData = await getMintPayload(
        walletData.address,
        quantity,
        collectionSlug,
      );
      const result = await sendTx(
        txData,
        pk,
        provider,
        walletData.chainId,
        walletData.nonce,
      );
      results.push({
        privateKey: pk,
        success: true,
        hash: result.hash,
        block: result.block,
      });
    } catch (err) {
      results.push({ privateKey: pk, success: false, error: err.message });
    }
  }

  const success = results.filter((r) => r.success);
  const fail = results.filter((r) => !r.success);

  for (const r of success) {
    await bot.api.sendMessage(
      chatId,
      `- ${r.privateKey.slice(0, 12)}... Copy mint triggered and was successful. TX: ${r.hash}`,
    );
  }
  for (const r of fail) {
    await bot.api.sendMessage(
      chatId,
      `- ${r.privateKey.slice(0, 12)}... Copy mint triggered but failed. Reason: ${r.error}`,
    );
  }
}

async function pollWalletsHandler(job) {
  const { chatId } = job.attrs.data;

  try {
    const events = await pollAllTrackedWallets(chatId);

    if (events.length === 0) return;

    const seen = new Set();
    for (const event of events) {
      const key = `${event.collectionSlug}-${event.chain}`;
      if (seen.has(key)) continue;
      seen.add(key);

      await triggerReplayMint(chatId, event);
    }
  } catch (err) {
    console.error(`Poll failed for chat ${chatId}:`, err);
    await bot.api.sendMessage(chatId, `Poll error: ${err.message}`);
  }
}

export async function startMonitoring(chatId) {
  const jobName = `pollWallets_${chatId}`;

  try {
    agenda.define(jobName, pollWalletsHandler);
  } catch {
    // Job already defined
  }

  await agenda.every("1 minute", jobName, { chatId });

  await bot.api.sendMessage(
    chatId,
    "Monitoring started! Polling every minute for free mints.",
  );
}

export async function stopMonitoring(chatId) {
  await agenda.cancel({ name: `pollWallets_${chatId}` });
  await bot.api.sendMessage(chatId, "Monitoring stopped.");
}

export async function resumeActiveMonitors() {
  const { getTrackedWallets } = await import("./lib/walletStorage.js");
  const wallets = await getTrackedWallets(null);
  if (!wallets || wallets.length === 0) return;

  const chatIds = [...new Set(wallets.map((w) => w.chatId))];

  for (const chatId of chatIds) {
    try {
      await startMonitoring(chatId);
      console.log(`Resumed monitoring for chat ${chatId}`);
    } catch (err) {
      console.error(`Failed to resume monitoring for chat ${chatId}:`, err);
    }
  }
}
