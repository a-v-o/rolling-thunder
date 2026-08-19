import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

import { BASE_URL, RPC } from "./variables.js";
import { bot } from "./bot.js";

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

// export async function checkBalance(privateKey) {
//   const provider = new ethers.JsonRpcProvider(DROP.rpcUrl);
//   const wallet = new ethers.Wallet(privateKey, provider);
//   const balance = await provider.getBalance(wallet.address);
//   console.log(privateKey, `Balance: ${ethers.formatEther(balance)} ETH`);
//   return balance;
// }

// export async function checkBalances(privateKeys) {
//   const balances = await Promise.all(privateKeys.map((pk) => checkBalance(pk)));
//   return balances;
// }

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

export async function waitForMint(mintTimeISO, chatId, slug) {
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
    } else {
      await sleep(50);
    }
  }
  await bot.api.sendMessage(chatId, "Mint time reached — firing!");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const preparedWalletPromises = await Promise.allSettled(walletPromises);

  const preparedWallets = preparedWalletPromises.map(
    (promise) => promise.value,
  );

  if (scheduleTime) {
    await waitForMint(scheduleTime.toISOString(), chatId, slug);
  }

  const mintPromises = preparedWallets.map((wallet) =>
    mintWithWallet(wallet, quantity, slug, provider),
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
