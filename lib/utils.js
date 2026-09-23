import { decryptPrivateKey } from "./crypto.js";
import { ethers } from "ethers";

function getWalletLabel(wallet) {
  if (wallet.address) return wallet.address;

  try {
    return new ethers.Wallet(wallet.pk).address;
  } catch {
    return "wallet";
  }
}

export function getDecryptedKeys(encryptedKeys) {
  return encryptedKeys.map((encryptedKey) => decryptPrivateKey(encryptedKey));
}

export function parsePrivateKeyLines(text) {
  return text
    .split("\n")
    .map((key) => key.trim())
    .filter((key) => key.length > 0)
    .filter((key) => key.length >= 64);
}

export function getSessionPrivateKeys(session) {
  if (!session.encryptedKeys?.length) return null;
  return getDecryptedKeys(session.encryptedKeys);
}

export function parseGasBudgetInput(text) {
  const budgetText = String(text ?? "")
    .trim()
    .toLowerCase();
  const skipBudget = budgetText === "none" || budgetText === "skip";

  if (skipBudget) {
    return { skipBudget: true, gasBudgetUsd: undefined };
  }

  const gasBudgetUsd = Number(text);
  if (!Number.isFinite(gasBudgetUsd) || gasBudgetUsd <= 0) {
    throw new Error(
      "Please enter a positive USD gas budget, or reply 'none' to use the network default.",
    );
  }

  return { skipBudget: false, gasBudgetUsd: String(gasBudgetUsd) };
}

export async function reportResults(reply, results, type = "Operation") {
  const { success = [], fail = [] } = results;

  for (const wallet of success) {
    await reply(
      `- ${getWalletLabel(wallet)} ${type} successful. TX hash: ${wallet.txHash}`,
    );
  }

  for (const wallet of fail) {
    await reply(
      `- ${getWalletLabel(wallet)} ${type} failed. Reason: ${wallet.err}.`,
    );
  }

  if (fail.length > 0) {
    await reply(
      "Failed wallets were not included in this message. Re-enter the keys to retry.",
    );
  }
}

export function splitMintResults(results) {
  const success = [];
  const fail = [];

  for (const result of results) {
    if (result.success) {
      success.push({
        pk: result.privateKey,
        address: result.address,
        txHash: `${result.hash} @ block ${result.block}`,
      });
    } else {
      fail.push({
        pk: result.privateKey,
        address: result.address,
        err: result.error,
      });
    }
  }

  return { success, fail };
}

export async function reportMintResults(reply, results, type = "Mint") {
  await reportResults(reply, splitMintResults(results), type);
}
