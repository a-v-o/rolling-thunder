import {
  getDrop,
  getCollectionDetails,
  isStageLive,
} from "./lib/openseaApi.js";
import { mintWithWallet, prepareMintWallets } from "./lib/walletMint.js";

export {
  getDrop,
  getDropStages,
  getCollectionDetails,
  isStageLive,
} from "./lib/openseaApi.js";
export {
  sendTx,
  fetchChainIdAndNonce,
  prepareWallet,
} from "./lib/walletMint.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForMint(mintTimeISO, slug, stage, sendMessage) {
  const mintTime = new Date(mintTimeISO).getTime();

  await sendMessage(`Mint scheduled for ${mintTimeISO}`);
  await sendMessage(`Current time: ${new Date().toISOString()}`);

  while (true) {
    const now = Date.now();
    const remaining = mintTime - now;

    if (remaining <= 0) break;

    if (remaining > 30000) {
      await getCollectionDetails(slug);
      await sendMessage(`${Math.round(remaining / 1000)}s remaining...`);
      await sleep(Math.min(remaining - 30000, 30000));
    } else if (remaining > 2000) {
      await getCollectionDetails(slug);
      await sendMessage(`${Math.round(remaining / 1000)}s remaining...`);
      await sleep(1000);
    } else if (stage) {
      if (isStageLive(stage)) break;
      await sleep(50);
    } else {
      await sleep(50);
    }
  }

  if (stage) {
    while (true) {
      const drop = await getDrop(slug);
      const isLive = drop.active_stage.label === stage.label;
      if (isLive) break;
      await sleep(100);
    }
  }

  await sendMessage("Mint time reached — firing!");
}

export async function mintWithWallets(
  privateKeys,
  slug,
  quantity,
  chain,
  scheduleTime,
  stage,
  sendMessage = async () => {},
) {
  const { provider, entries } = await prepareMintWallets(privateKeys, chain);

  if (scheduleTime) {
    await waitForMint(scheduleTime.toISOString(), slug, stage, sendMessage);
  }

  const mintPromises = entries.map((entry) =>
    entry.ok
      ? mintWithWallet(entry.wallet, quantity, slug, provider)
      : Promise.resolve({
          privateKey: entry.privateKey,
          success: false,
          error: entry.error,
        }),
  );

  const results = await Promise.allSettled(mintPromises);

  return results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    return {
      privateKey: privateKeys[index],
      success: false,
      error: result.reason?.message || String(result.reason),
    };
  });
}
