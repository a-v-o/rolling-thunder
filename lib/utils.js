import { decryptPrivateKey } from "./crypto.js";

export function getDecryptedKeys(encryptedKeys) {
  return encryptedKeys.map((encryptedKey) => decryptPrivateKey(encryptedKey));
}

export async function reportResults(reply, results, type = "Operation") {
  const { success = [], fail = [] } = results;

  for (const wallet of success) {
    await reply(
      `- ${wallet.pk.slice(0, 12)}... ${type} successful. TX hash: ${wallet.txHash}`,
    );
  }

  for (const wallet of fail) {
    await reply(
      `- ${wallet.pk.slice(0, 12)}... ${type} failed. Reason: ${wallet.err}.`,
    );
  }

  if (fail.length !== 0) {
    await reply("All failed keys are below so you can retry:");
    await reply(fail.map((wallet) => wallet.pk).join("\n"));
  }
}

export function splitMintResults(results) {
  const success = [];
  const fail = [];

  for (const result of results) {
    if (result.success) {
      success.push({
        pk: result.privateKey,
        txHash: `${result.hash} @ block ${result.block}`,
      });
    } else {
      fail.push({ pk: result.privateKey, err: result.error });
    }
  }

  return { success, fail };
}
