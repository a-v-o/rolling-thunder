import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

import { BASE_URL, RPC } from "./variables.js";
import { bot } from "./bot.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getDrop(slug) {
  const response = await fetch(`${BASE_URL}/drops/${slug}`, {
    headers: { "X-API-KEY": process.env.API_KEY, accept: "application/json" },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const errorString = (data.errors || []).join(", ") || response.statusText;
    throw new Error(
      `Failed to fetch drop stages: HTTP ${response.status} ${errorString}`,
    );
  }

  const data = await response.json();
  return data;
}

export async function getDropStages(slug) {
  const drop = await getDrop(slug);
  return drop.stages || [];
}

export function isStageLive(stage, now = new Date()) {
  if (!stage) return false;
  const start = stage.startTime ? new Date(stage.startTime) : null;
  const end = stage.endTime ? new Date(stage.endTime) : null;
  if (start && now < start) return false;
  if (end && now > end) return false;
  return true;
}

export async function getCollectionDetails(slug) {
  try {
    const response = await fetch(`${BASE_URL}/collections/${slug}`);
    if (!response.ok) {
      const data = await response.json();
      for (const error of data.errors || []) {
        console.error(error);
      }
    }
    const data = await response.json();
    // console.log(data);
    return data;
  } catch (error) {
    console.error(error);
  }
}

export async function getMintPayload(
  walletAddress,
  quantity,
  slug,
  retries = 5,
) {
  try {
    const response = await fetch(`${BASE_URL}/drops/${slug}/mint`, {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        minter: walletAddress,
        quantity: Number(quantity),
      }),
    });
    if (!response.ok) {
      retries = 0;
      const data = await response.json();
      for (const error of data.errors || []) {
        console.log(`Error for ${walletAddress}: ${error}`);
      }
      const errorString = data.errors.join(", ");
      throw new Error(`HTTP ${response.status}: ${errorString}`);
    }
    const data = await response.json();
    return data;
  } catch (error) {
    if (retries > 0) {
      console.error(
        `Fetch failed for ${walletAddress}: ${error.message}. ${retries} retries left. Retrying in 1s...`,
      );
      await sleep(1000);
      return getMintPayload(walletAddress, quantity, slug, retries - 1);
    } else {
      throw new Error(`Failed to fetch mint payload: ${error.message}`, {
        cause: error,
      });
    }
  }
}

export async function sendTx(txData, privateKey, provider, chainId, nonce) {
  const wallet = new ethers.Wallet(privateKey, provider);
  const txValue = BigInt(txData.value || "0");

  const tx = {
    to: txData.to,
    data: txData.data,
    value: txValue,
    chainId,
    nonce,
  };

  const sent = await wallet.sendTransaction(tx);
  const receipt = await sent.wait();
  const ok = receipt.status === 1;

  return {
    privateKey,
    success: ok,
    hash: sent.hash,
    block: receipt.blockNumber,
  };
}

export async function waitForMint(mintTimeISO, chatId, slug, stage) {
  const mintTime = new Date(mintTimeISO).getTime();

  await bot.api.sendMessage(chatId, `Mint scheduled for ${mintTimeISO}`);
  await bot.api.sendMessage(
    chatId,
    `Current time: ${new Date().toISOString()}`,
  );

  while (true) {
    const now = Date.now();
    const remaining = mintTime - now;

    if (remaining <= 0) break;

    if (remaining > 30000) {
      await getCollectionDetails(slug);
      await bot.api.sendMessage(
        chatId,
        `${Math.round(remaining / 1000)}s remaining...`,
      );
      await sleep(Math.min(remaining - 30000, 30000));
    } else if (remaining > 2000) {
      await getCollectionDetails(slug);
      await bot.api.sendMessage(
        chatId,
        `${Math.round(remaining / 1000)}s remaining...`,
      );
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
      const drop = getDrop(slug);
      const isLive = drop.active_stage.label === stage.label;
      if (isLive) break;
      await sleep(100);
    }
  }

  await bot.api.sendMessage(chatId, "Mint time reached — firing!");
}

export async function fetchChainIdAndNonce(walletAddress, provider) {
  const [chainId, nonce] = await Promise.all([
    provider.getNetwork().then((network) => network.chainId),
    provider.getTransactionCount(walletAddress),
  ]);
  return { chainId: Number(chainId), nonce };
}

export async function prepareWallet(privateKey, provider) {
  const walletAddress = new ethers.Wallet(privateKey).address;

  const { chainId, nonce } = await fetchChainIdAndNonce(
    walletAddress,
    provider,
  );

  return { privateKey, chainId, nonce };
}

export async function mintWithWallet(wallet, quantity, slug, provider) {
  const walletAddress = new ethers.Wallet(wallet.privateKey).address;

  try {
    const txData = await getMintPayload(walletAddress, quantity, slug);
    const result = await sendTx(
      txData,
      wallet.privateKey,
      provider,
      wallet.chainId,
      wallet.nonce,
    );
    return result;
  } catch (e) {
    return { privateKey: wallet.privateKey, success: false, error: e.message };
  }
}

export async function mintWithWallets(
  privateKeys,
  slug,
  quantity,
  chain,
  chatId,
  scheduleTime,
) {
  const rpcUrl = RPC[chain];

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const walletPromises = privateKeys.map((pk) => prepareWallet(pk, provider));
  const preparedResults = await Promise.allSettled(walletPromises);

  const prepared = preparedResults.map((result, i) =>
    result.status === "fulfilled"
      ? { ok: true, wallet: result.value }
      : {
          ok: false,
          privateKey: privateKeys[i],
          error: result.reason?.message || String(result.reason),
        },
  );

  if (scheduleTime) {
    await waitForMint(scheduleTime.toISOString(), chatId, slug);
  }

  const mintPromises = prepared.map((entry) =>
    entry.ok
      ? mintWithWallet(entry.wallet, quantity, slug, provider)
      : Promise.resolve({
          privateKey: entry.privateKey,
          success: false,
          error: entry.error,
        }),
  );

  const results = await Promise.allSettled(mintPromises);

  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      privateKey: privateKeys[i],
      success: false,
      error: r.reason?.message || String(r.reason),
    };
  });
}
