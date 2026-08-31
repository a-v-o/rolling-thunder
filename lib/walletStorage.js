import { ethers } from "ethers";
import { decryptPrivateKey } from "./crypto.js";
import { connectDb, TrackedWallet, BotWallet } from "../models/db.js";

export async function getBotWallets(chatId) {
  await connectDb();
  return BotWallet.find({ chatId, active: true });
}

export async function saveBotWalletsEncrypted(chatId, encryptedKeys, chain) {
  await connectDb();

  const docs = encryptedKeys.map((encKey) => {
    const pk = decryptPrivateKey(encKey);
    const wallet = new ethers.Wallet(pk);
    return {
      chatId,
      encryptedKey: encKey,
      address: wallet.address,
      chain,
      active: true,
    };
  });

  await BotWallet.insertMany(docs, { ordered: false }).catch((err) => {
    if (err.code !== 11000) throw err;
  });

  return docs.map((d) => d.address);
}

export async function clearBotWallets(chatId) {
  await connectDb();
  await BotWallet.deleteMany({ chatId });
}

export async function saveTrackedWallets(chatId, addresses, chain) {
  await connectDb();

  const docs = addresses.map((address) => ({
    chatId,
    address: ethers.getAddress(address),
    chain,
    lastCursor: null,
    lastPolledAt: null,
    active: true,
  }));

  await TrackedWallet.insertMany(docs, { ordered: false }).catch((err) => {
    if (err.code !== 11000) throw err;
  });

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

export async function getLastCursor(chatId, address) {
  await connectDb();
  const wallet = await TrackedWallet.findOne({ chatId, address });
  return wallet?.lastCursor ?? null;
}

export async function setLastCursor(chatId, address, cursor) {
  await connectDb();
  await TrackedWallet.updateOne(
    { chatId, address },
    { $set: { lastCursor: cursor, lastPolledAt: new Date() } },
  );
}
