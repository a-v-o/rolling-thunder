import { ethers } from "ethers";
import { decryptPrivateKey } from "./crypto.js";
import { connectDb, TrackedWallet, BotWallet } from "../models/db.js";

export async function getBotWallets(chatId) {
  await connectDb();
  return BotWallet.find({ chatId, active: true });
}

export async function saveBotWalletsEncrypted(chatId, encryptedKeys, chain) {
  await connectDb();

  // Derive addresses and deduplicate against existing wallets for this chat
  const existing = await BotWallet.find({ chatId }).distinct("address");
  const existingSet = new Set(existing);

  const docs = [];
  const seen = new Set();
  for (const encKey of encryptedKeys) {
    const pk = decryptPrivateKey(encKey);
    const address = new ethers.Wallet(pk).address;
    if (existingSet.has(address) || seen.has(address)) continue;
    seen.add(address);
    docs.push({ chatId, encryptedKey: encKey, address, chain, active: true });
  }

  if (docs.length > 0) {
    await BotWallet.insertMany(docs, { ordered: false });
  }

  return docs.map((d) => d.address);
}

export async function clearBotWallets(chatId) {
  await connectDb();
  await BotWallet.deleteMany({ chatId });
}

export async function saveTrackedWallets(chatId, addresses, chain) {
  await connectDb();

  // Deduplicate against existing tracked wallets for this chat
  const existing = await TrackedWallet.find({ chatId }).distinct("address");
  const existingSet = new Set(existing);

  const docs = [];
  const seen = new Set();
  for (const address of addresses) {
    const normalized = ethers.getAddress(address);
    if (existingSet.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    docs.push({
      chatId,
      address: normalized,
      chain,
      lastCursor: null,
      lastPolledAt: null,
      active: true,
    });
  }

  if (docs.length > 0) {
    await TrackedWallet.insertMany(docs, { ordered: false });
  }

  return docs.map((d) => d.address);
}

export async function getTrackedWallets(chatId) {
  await connectDb();
  const filter = { active: true };
  if (chatId !== null) filter.chatId = chatId;
  return TrackedWallet.find(filter);
}

export async function deactivateTrackedWallets(chatId) {
  await connectDb();
  await TrackedWallet.updateMany({ chatId }, { $set: { active: false } });
}

export async function deactivateSpecificWallets(chatId, addresses) {
  await connectDb();
  const normalized = addresses.map((a) => ethers.getAddress(a));
  await TrackedWallet.updateMany(
    { chatId, address: { $in: normalized } },
    { $set: { active: false } },
  );
}

export async function reactivateTrackedWallets(chatId, addresses = null) {
  await connectDb();
  const filter = { chatId, active: false };
  if (addresses && addresses.length > 0) {
    const normalized = addresses.map((a) => ethers.getAddress(a));
    filter.address = { $in: normalized };
  }
  const result = await TrackedWallet.updateMany(filter, {
    $set: { active: true },
  });
  return result.modifiedCount;
}

export async function getInactiveTrackedWallets(chatId) {
  await connectDb();
  return TrackedWallet.find({ chatId, active: false });
}

export async function getLastEventTimestamp(chatId, address) {
  await connectDb();
  const wallet = await TrackedWallet.findOne({ chatId, address });
  return Number(wallet?.lastEventTimestamp) ?? null;
}

export async function setLastEventTimestamp(chatId, address, timestamp) {
  await connectDb();
  await TrackedWallet.updateOne(
    { chatId, address },
    { $set: { lastEventTimestamp: timestamp, lastPolledAt: new Date() } },
  );
}
