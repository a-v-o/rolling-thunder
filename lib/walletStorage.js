import { ethers } from "ethers";
import { decryptPrivateKey } from "./crypto.js";
import { connectDb, TrackedWallet, BotWallet } from "../models/db.js";

export async function getBotWallets(chatId) {
  await connectDb();
  return BotWallet.find({ chatId, active: true });
}

export async function saveBotWalletsEncrypted(chatId, encryptedKeys) {
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
    docs.push({ chatId, encryptedKey: encKey, address, active: true });
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

  const saved = [];
  for (const address of addresses) {
    const normalized = ethers.getAddress(address);
    const wallet =
      (await TrackedWallet.findOne({ address: normalized })) ||
      new TrackedWallet({ address: normalized });

    let subscription = wallet.subscriptions.find(
      (subscription) => subscription.chatId === String(chatId),
    );
    if (!subscription) {
      subscription = { chatId: String(chatId), chains: [] };
      wallet.subscriptions.push(subscription);
    }
    if (!subscription.chains.includes(chain)) subscription.chains.push(chain);
    await wallet.save();
    saved.push(normalized);
  }

  return [...new Set(saved)];
}

export async function getTrackedWallets(chatId = null) {
  await connectDb();
  const filter =
    chatId === null ? {} : { "subscriptions.chatId": String(chatId) };
  return TrackedWallet.find(filter);
}

export async function deactivateTrackedWallets(chatId) {
  await connectDb();
  await TrackedWallet.updateMany(
    { "subscriptions.chatId": String(chatId) },
    { $pull: { subscriptions: { chatId: String(chatId) } } },
  );
}

export async function deactivateSpecificWallets(chatId, addresses) {
  await connectDb();
  const normalized = addresses.map((a) => ethers.getAddress(a));
  await TrackedWallet.updateMany(
    { address: { $in: normalized } },
    { $pull: { subscriptions: { chatId: String(chatId) } } },
  );
}

export async function getLastEventTimestamp(address) {
  await connectDb();
  const wallet = await TrackedWallet.findOne({
    address: ethers.getAddress(address),
  });
  return wallet?.lastEventTimestamp == null
    ? null
    : Number(wallet.lastEventTimestamp);
}

export async function setLastEventTimestamp(address, timestamp) {
  await connectDb();
  await TrackedWallet.updateOne(
    { address: ethers.getAddress(address) },
    {
      $set: { lastEventTimestamp: String(timestamp), lastPolledAt: new Date() },
    },
  );
}

export async function activateTrackedWalletChains(chatId, addresses, chain) {
  await connectDb();
  const normalized = addresses.map((address) => ethers.getAddress(address));
  let count = 0;
  for (const address of normalized) {
    const wallet = await TrackedWallet.findOne({ address });
    if (!wallet) continue;
    const subscription = wallet.subscriptions.find(
      (item) => item.chatId === String(chatId),
    );
    if (!subscription) {
      wallet.subscriptions.push({ chatId: String(chatId), chains: [chain] });
    } else if (!subscription.chains.includes(chain)) {
      subscription.chains.push(chain);
    }
    await wallet.save();
    count += 1;
  }
  return count;
}

export async function deactivateTrackedWalletChains(chatId, addresses, chain) {
  await connectDb();
  const normalized = addresses.map((address) => ethers.getAddress(address));
  const result = await TrackedWallet.updateMany(
    { address: { $in: normalized }, "subscriptions.chatId": String(chatId) },
    { $pull: { "subscriptions.$.chains": chain } },
  );
  return result.modifiedCount;
}
