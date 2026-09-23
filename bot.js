import dotenv from "dotenv";
import { Bot } from "grammy";
import { Menu } from "@grammyjs/menu";
import { encryptPrivateKey } from "./lib/crypto.js";
import { startSession, getSession, clearSession } from "./lib/mintSession.js";
import { START_TEXT, HELP_TEXT } from "./lib/messages.js";
import { mintWithWallets, getDropStages, isStageLive } from "./mint.js";
import express from "express";
import { acceptBestOffer, listNfts, transferNFTs } from "./list.js";
import {
  getDecryptedKeys,
  getSessionPrivateKeys,
  parseGasBudgetInput,
  parsePrivateKeyLines,
  reportResults,
  reportMintResults,
} from "./lib/utils.js";
import { agenda } from "./agenda.js";
import {
  saveBotWalletsEncrypted,
  saveTrackedWallets,
  getTrackedWallets,
  deactivateTrackedWallets,
  deactivateSpecificWallets,
  activateTrackedWalletChains,
  deactivateTrackedWalletChains,
  clearBotWallets,
} from "./lib/walletStorage.js";
import {
  startMonitoring,
  stopMonitoring,
  resumeActiveMonitors,
} from "./monitor.js";
import { registerMintJob } from "./lib/mintJob.js";
import { registerFundMintTransferJob } from "./lib/fundMintJob.js";
import {
  executeContractFunction,
  fetchContractAbi,
  formatContractFunctions,
  getMintFunctions,
  parseContractArgument,
} from "./lib/contractMint.js";
import { ethers } from "ethers";
import { RPC } from "./variables.js";

dotenv.config();

export const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

const app = express();

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Server is running and bot is polling!");
});

registerMintJob(agenda, bot);
registerFundMintTransferJob(agenda, bot);

await agenda.start();

// Chain-selection prompt shown right after wallets are imported, and the
// follow-up step each flow moves to once a chain is picked.
const FLOW_CONFIG = {
  mint: {
    chainPrompt:
      "Now send the target chain for minting (for example: ethereum, robinhood, base, ink).",
    nextStep: "amount",
    nextPrompt: "Enter the amount of nft's you'd like to mint.",
  },
  sell: {
    chainPrompt:
      "Now send the target chain for selling (ethereum, robinhood, base, ink).",
    nextStep: "slug",
    nextPrompt: "Enter the nft's opensea slug.",
  },
  transfer: {
    chainPrompt:
      "Now send the target chain for transferring the nfts (ethereum, robinhood, base, ink).",
    nextStep: "slug",
    nextPrompt: "Enter the nft's opensea slug.",
  },
  list: {
    chainPrompt:
      "Now send the target chain for listing the nfts (ethereum, robinhood, base, ink).",
    nextStep: "slug",
    nextPrompt: "Enter the nft's opensea slug.",
  },
  track: {
    chainPrompt:
      "Now send the chain to monitor (ethereum, robinhood, base, ink).",
    nextStep: "addresses",
    nextPrompt: "Enter the wallet addresses to track, one per line.",
  },
  fundMintTransfer: {
    chainPrompt:
      "Now send the target chain (for example: ethereum, robinhood, base, ink).",
    nextStep: "slug",
    nextPrompt: "Enter the NFT's OpenSea slug.",
  },
  contractMint: {
    chainPrompt:
      "Now send the target chain for contract minting (ethereum, robinhood, base, ink).",
    nextStep: "contract",
    nextPrompt: "Send the NFT contract address.",
  },
};

const MISSING_WALLET_MESSAGE =
  "Wallet data missing. Please start the mint process again.";
const GAS_BUDGET_PROMPT =
  "Enter the maximum gas budget in USD per wallet (for example: 5), or reply 'none' to use the network default.";

const mainMenu = new Menu("main-menu");

function getFlowType(label) {
  if (label === "Fund, Mint & Transfer") return "fundMintTransfer";
  if (label === "Contract Mint") return "contractMint";
  return label.toLowerCase();
}

function getPrivateKeyPrompt(label) {
  return label === "Track"
    ? "Send your bot private key(s) for replay minting, one per line.\nSend /cancel to stop."
    : "Please send your private key(s), one per line.\nSend /cancel to stop.";
}

async function requireWalletKeys(ctx, session) {
  const privateKeys = getSessionPrivateKeys(session);
  if (!privateKeys) {
    await ctx.reply(MISSING_WALLET_MESSAGE);
    return null;
  }
  return privateKeys;
}

for (const label of [
  "Mint",
  "Sell",
  "Transfer",
  "List",
  "Track",
  "Fund, Mint & Transfer",
  "Contract Mint",
]) {
  mainMenu
    .text(label, async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      startSession(chatId, getFlowType(label));
      await ctx.reply(getPrivateKeyPrompt(label));
    })
    .row();
}

mainMenu
  .text("Help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  })
  .row();

bot.use(mainMenu);

bot.command("start", async (ctx) => {
  await ctx.reply(START_TEXT, { reply_markup: mainMenu });
});

bot.command("untrack", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const args = ctx.match?.toString().trim();
  if (args) {
    // Untrack specific wallets
    const addresses = args.split("\n").map((a) => a.trim());
    await deactivateSpecificWallets(chatId, addresses);
    await ctx.reply(`Stopped tracking ${addresses.length} wallet(s).`);
  } else {
    // Untrack all wallets
    await stopMonitoring(chatId);
    await deactivateTrackedWallets(chatId);
    await clearBotWallets(chatId);
    await ctx.reply("Monitoring stopped and all tracked wallets cleared.");
  }
});

bot.command("wallets", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const active = await getTrackedWallets(chatId);
  if (active.length === 0) {
    await ctx.reply("No wallets being tracked. Use the Track menu to start.");
    return;
  }
  let msg = "";
  if (active.length > 0) {
    msg += `Active wallets:\n${active
      .map((w) => {
        const subscription = w.subscriptions.find(
          (item) => item.chatId === String(chatId),
        );
        return `- ${w.address} (${subscription?.chains.join(", ") || "no chains"})`;
      })
      .join("\n")}\n`;
  }
  await ctx.reply(msg);
});

function parseChainWalletCommand(ctx) {
  const lines = ctx.match?.toString().trim().split(/\s+/);
  if (!lines || lines.length < 2) return null;
  return { chain: lines[0].toLowerCase(), addresses: lines.slice(1) };
}

bot.command("activateChain", async (ctx) => {
  const chatId = ctx.chat?.id;
  const command = parseChainWalletCommand(ctx);
  if (!chatId || !command) {
    await ctx.reply(
      "Usage: /activateChain <chain> <wallet address> [wallet address ...]",
    );
    return;
  }
  if (!RPC[command.chain]) {
    await ctx.reply(`Unsupported chain: ${command.chain}`);
    return;
  }

  try {
    const count = await activateTrackedWalletChains(
      chatId,
      command.addresses,
      command.chain,
    );
    await ctx.reply(`Activated ${command.chain} for ${count} wallet(s).`);
  } catch (error) {
    await ctx.reply(`Could not activate chain: ${error.message}`);
  }
});

bot.command("deactivateChain", async (ctx) => {
  const chatId = ctx.chat?.id;
  const command = parseChainWalletCommand(ctx);
  if (!chatId || !command) {
    await ctx.reply(
      "Usage: /deactivateChain <chain> <wallet address> [wallet address ...]",
    );
    return;
  }
  if (!RPC[command.chain]) {
    await ctx.reply(`Unsupported chain: ${command.chain}`);
    return;
  }

  try {
    const count = await deactivateTrackedWalletChains(
      chatId,
      command.addresses,
      command.chain,
    );
    await ctx.reply(`Deactivated ${command.chain} for ${count} wallet(s).`);
  } catch (error) {
    await ctx.reply(`Could not deactivate chain: ${error.message}`);
  }
});

bot.command("unschedule", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const slug = ctx.match?.toString().trim();
  if (!slug) {
    await ctx.reply("Usage: /unschedule <collection-slug>");
    return;
  }

  const { jobs } = await agenda.queryJobs({
    name: "mint",
    "data.chatId": chatId,
    "data.slug": slug,
  });

  if (jobs.length === 0) {
    await ctx.reply(`No scheduled mints found for "${slug}".`);
    return;
  }

  await agenda.cancel({
    name: "mint",
    "data.chatId": chatId,
    "data.slug": slug,
  });
  await ctx.reply(`Canceled ${jobs.length} scheduled mint(s) for "${slug}".`);
});

function formatStageList(stages) {
  return stages
    .map((stage, index) => {
      const status = isStageLive(stage) ? "🟢 LIVE" : "⚪ not live";
      return (
        `${index + 1}. ${stage.label} (${status})\n` +
        `   Price: ${stage.price}  Max/wallet: ${stage.max_per_wallet}\n` +
        `   Start: ${stage.start_time}\n   End: ${stage.end_time}`
      );
    })
    .join("\n\n");
}

async function scheduleFundMintTransfer(ctx, chatId, session) {
  const { encryptedKeys, encryptedFundingKey, fundingAmount, mintTime } =
    session;
  if (
    !encryptedKeys?.length ||
    !encryptedFundingKey ||
    !fundingAmount ||
    !mintTime
  ) {
    await ctx.reply(
      "Wallet or stage data missing. Please start the flow again.",
    );
    clearSession(chatId);
    return;
  }

  const mintTimeDate = new Date(mintTime);
  const fundingLeadSeconds = 10;
  const fundingTime = new Date(
    mintTimeDate.getTime() - fundingLeadSeconds * 1000,
  );

  if (Number.isNaN(mintTimeDate.getTime()) || fundingTime <= new Date()) {
    await ctx.reply(
      "This stage starts too soon to schedule funding. Starting the fund, mint, and transfer flow immediately.",
    );
    await agenda.now("fundMintTransfer", {
      encryptedKeys,
      encryptedFundingKey,
      destination: session.destination,
      slug: session.slug,
      quantity: session.quantity,
      fundingAmount,
      chain: session.chain,
      mintTime: new Date(),
      stage: session.stage,
      gasBudgetUsd: session.gasBudgetUsd,
      chatId,
    });
    clearSession(chatId);
    return;
  }

  await agenda.schedule(fundingTime, "fundMintTransfer", {
    encryptedKeys,
    encryptedFundingKey,
    destination: session.destination,
    slug: session.slug,
    quantity: session.quantity,
    fundingAmount,
    chain: session.chain,
    mintTime: mintTimeDate,
    stage: session.stage,
    gasBudgetUsd: session.gasBudgetUsd,
    chatId,
  });

  await ctx.reply(
    `Fund, mint, and transfer scheduled.\n\n` +
      `Funding: ${fundingTime.toLocaleString()}\n` +
      `Mint stage: ${session.stage.label} at ${mintTimeDate.toLocaleString()}\n` +
      `Wallets: ${encryptedKeys.length}\n` +
      `Destination: ${session.destination}`,
  );
  clearSession(chatId);
}

/**
 * Schedules a mint for a stage's own startTime — used when the selected
 * stage isn't live yet. Replaces manual date/time entry: the stage's start
 * time is the source of truth.
 */
async function scheduleMintForStage(ctx, chatId, session) {
  const { slug, chain, quantity, encryptedKeys, stage, gasBudgetUsd } = session;

  const scheduleTime = new Date(stage.start_time);
  const firingTime = new Date(scheduleTime);
  firingTime.setSeconds(scheduleTime.getSeconds() - 30);

  if (firingTime <= new Date()) {
    await ctx.reply(
      `Stage "${stage.label}" starts in less than 30 seconds — too soon to schedule reliably. Start again once it's live to fire immediately, or pick it up again with more lead time.`,
    );
    clearSession(chatId);
    return;
  }

  await agenda.schedule(firingTime, "mint", {
    encryptedKeys,
    slug,
    quantity,
    chain,
    chatId,
    scheduleTime,
    stage,
    gasBudgetUsd,
  });

  const formattedTime = scheduleTime.toLocaleString();
  await ctx.reply(
    `Mint scheduled for stage "${stage.label}" start at ${formattedTime}.\n\n✓ ${encryptedKeys.length} wallet(s)\n✓ Slug: ${slug}\n✓ Chain: ${chain}`,
  );

  clearSession(chatId);
}

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text?.trim();
  if (!text) return;

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const session = getSession(chatId);
  if (!session) return;

  if (text.startsWith("/")) {
    if (text.toLowerCase() === "/cancel") {
      clearSession(chatId);
      await ctx.reply("Mint request canceled.");
    }
    return;
  }

  const config = FLOW_CONFIG[session.type];
  if (!config) {
    await ctx.reply("Something went wrong. Start the mint process again");
    clearSession(chatId);
    return;
  }

  if (session.step === "wallet") {
    const validKeys = parsePrivateKeyLines(text);

    if (validKeys.length === 0) {
      await ctx.reply(
        "No valid private keys found. Please send private keys (at least 64 characters), one per line.",
      );
      return;
    }

    session.encryptedKeys = validKeys.map((key) => encryptPrivateKey(key));
    session.step = "chain";
    await ctx.reply(
      `Imported ${validKeys.length} wallet(s).\n${config.chainPrompt}`,
    );
    return;
  }

  if (session.step === "chain") {
    session.chain = text.toLowerCase();

    if (session.type === "contractMint" && !RPC[session.chain]) {
      await ctx.reply(
        `Unsupported chain or missing RPC configuration: ${session.chain}.`,
      );
      return;
    }

    if (session.type === "track" && session.encryptedKeys?.length > 0) {
      try {
        await saveBotWalletsEncrypted(chatId, session.encryptedKeys);
      } catch (err) {
        await ctx.reply(`Failed to save bot wallets: ${err.message}`);
        clearSession(chatId);
        return;
      }
    }

    session.step = config.nextStep;
    await ctx.reply(config.nextPrompt);
    return;
  }

  if (session.step === "contract") {
    let provider;
    try {
      session.contractAddress = ethers.getAddress(text);
      provider = new ethers.JsonRpcProvider(RPC[session.chain]);
      const network = await provider.getNetwork();
      session.abi = await fetchContractAbi(
        session.contractAddress,
        network.chainId,
      );
      session.functions = getMintFunctions(session.abi);
    } catch (error) {
      await ctx.reply(`Could not load the contract ABI: ${error.message}`);
      return;
    }

    if (session.functions.length === 0) {
      await ctx.reply("No state-changing functions were found in this ABI.");
      clearSession(chatId);
      return;
    }

    session.step = "contractFunction";
    await ctx.reply(
      `Available mint functions for ${session.contractAddress}:\n\n` +
        formatContractFunctions(session.abi) +
        "\n\nReply with the function number to use.",
    );
    return;
  }

  if (session.step === "contractFunction") {
    const choice = Number(text);
    if (
      !Number.isInteger(choice) ||
      choice < 1 ||
      choice > session.functions.length
    ) {
      await ctx.reply(
        `Please enter a number between 1 and ${session.functions.length}.`,
      );
      return;
    }

    session.functionAbi = session.functions[choice - 1];
    session.step = "contractArguments";
    session.contractArguments = [];
    session.contractArgumentIndex = 0;
    const inputs = session.functionAbi.inputs || [];
    const inputText = inputs.length
      ? inputs
          .map(
            (input, index) =>
              `${index + 1}. ${input.name || "unnamed"}: ${input.type}`,
          )
          .join("\n")
      : "This function has no parameters.";
    await ctx.reply(
      `Selected ${session.functionAbi.name}().\n\n${inputText}\n\n` +
        (inputs.length
          ? `Enter ${inputs[0].name || "parameter 1"} (${inputs[0].type}):`
          : "Reply 'none' to continue, or /cancel to stop."),
    );
    return;
  }

  if (session.step === "contractArguments") {
    const inputs = session.functionAbi.inputs || [];

    if (inputs.length === 0) {
      if (text.trim().toLowerCase() !== "none") {
        await ctx.reply(
          "This function does not accept parameters. Reply 'none'.",
        );
        return;
      }
    } else {
      const input = inputs[session.contractArgumentIndex];
      try {
        session.contractArguments.push(parseContractArgument(text, input));
      } catch (error) {
        await ctx.reply(error.message);
        return;
      }

      session.contractArgumentIndex += 1;
      if (session.contractArgumentIndex < inputs.length) {
        const nextInput = inputs[session.contractArgumentIndex];
        await ctx.reply(
          `Enter ${nextInput.name || `parameter ${session.contractArgumentIndex + 1}`} (${nextInput.type}):`,
        );
        return;
      }
    }

    if (session.functionAbi.stateMutability === "payable") {
      session.step = "contractValue";
      await ctx.reply(
        "Enter the ETH value to send with this mint (enter 0 for no value).",
      );
      return;
    }

    session.contractValue = "0";
    session.step = "contractConfirm";
    await ctx.reply(
      `Ready to call ${session.functionAbi.name} on ${session.contractAddress}. Reply "confirm" to execute or /cancel to stop.`,
    );
    return;
  }

  if (session.step === "contractValue") {
    try {
      const value = Number(text);
      if (!Number.isFinite(value) || value < 0)
        throw new Error("Value must be a non-negative ETH amount.");
      ethers.parseEther(text);
      session.contractValue = text;
      session.step = "contractConfirm";
      await ctx.reply(
        `Ready to call ${session.functionAbi.name} with ${text} ETH on ${session.contractAddress}. Reply "confirm" to execute or /cancel to stop.`,
      );
    } catch (error) {
      await ctx.reply(`Invalid ETH value: ${error.message}`);
    }
    return;
  }

  if (session.step === "contractConfirm") {
    if (text.toLowerCase() !== "confirm") {
      await ctx.reply('Reply "confirm" to execute, or /cancel to stop.');
      return;
    }

    try {
      const privateKeys = getDecryptedKeys(session.encryptedKeys || []);
      await ctx.reply(
        `Executing ${session.functionAbi.name} for ${privateKeys.length} wallet(s)...`,
      );
      const results = await Promise.all(
        privateKeys.map(async (privateKey) => {
          try {
            return await executeContractFunction({
              privateKey,
              chain: session.chain,
              contractAddress: session.contractAddress,
              functionAbi: session.functionAbi,
              args: session.contractArguments,
              value: session.contractValue,
            });
          } catch (error) {
            return {
              address: new ethers.Wallet(privateKey).address,
              success: false,
              error: error.message,
            };
          }
        }),
      );

      await ctx.reply(
        results
          .map((result) =>
            result.success
              ? `Success ${result.address}: ${result.hash}`
              : `Failed ${result.address}: ${result.error}`,
          )
          .join("\n"),
      );
    } catch (error) {
      await ctx.reply(`Contract mint failed: ${error.message}`);
    }
    clearSession(chatId);
    return;
  }

  if (session.step === "amount") {
    const quantity = Number(text);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      await ctx.reply("Please enter a valid positive number of nft's to mint.");
      return;
    }
    session.quantity = text;

    if (session.type === "fundMintTransfer") {
      session.step = "gasBudget";
      await ctx.reply(GAS_BUDGET_PROMPT);
      return;
    }

    session.step = "gasBudget";
    await ctx.reply(GAS_BUDGET_PROMPT);
    return;
  }

  if (session.step === "slug") {
    session.slug = text;

    if (session.type === "mint" || session.type === "fundMintTransfer") {
      let stages;
      try {
        stages = await getDropStages(session.slug);
      } catch (error) {
        await ctx.reply(`Could not fetch drop stages: ${error.message}`);
        clearSession(chatId);
        return;
      }

      if (!stages || stages.length === 0) {
        await ctx.reply(
          "No mint stages found for this slug. Start again with a different slug.",
        );
        clearSession(chatId);
        return;
      }

      session.stages = stages;
      session.step = "stage";

      await ctx.reply(
        `Select a mint stage by number:\n\n${formatStageList(stages)}`,
      );
      return;
    }

    if (session.type === "list") {
      session.step = "price";
      await ctx.reply(
        "How much would you like to list for (usd) or enter 'floor' to list at floor price",
      );
      return;
    }

    if (session.type === "transfer") {
      session.step = "recipient";
      await ctx.reply("Enter the wallet address to send the nfts to");
      return;
    }

    // session.type === "sell"
    const privateKeys = await requireWalletKeys(ctx, session);
    if (!privateKeys) return;

    const results = await acceptBestOffer(
      privateKeys,
      session.slug,
      session.chain,
    );
    await reportResults(ctx.reply.bind(ctx), results, "Sell");
    clearSession(chatId);
    return;
  }

  if (session.step === "price") {
    session.price = text;
    const privateKeys = await requireWalletKeys(ctx, session);
    if (!privateKeys) return;

    const results = await listNfts(
      privateKeys,
      session.slug,
      session.price,
      session.chain,
    );
    await reportResults(ctx.reply.bind(ctx), results, "List");
    clearSession(chatId);
    return;
  }

  if (session.step === "recipient") {
    session.recipientAddress = text;
    const privateKeys = await requireWalletKeys(ctx, session);
    if (!privateKeys) return;

    const results = await transferNFTs(
      privateKeys,
      session.slug,
      session.chain,
      session.recipientAddress,
    );
    await reportResults(ctx.reply.bind(ctx), results, "Transfer");
    clearSession(chatId);
    return;
  }

  if (session.step === "destination") {
    session.destination = text;
    session.step = "fundingKey";
    await ctx.reply(
      "Send the funding wallet private key. It will be encrypted for this session and never stored as plain text.",
    );
    return;
  }

  if (session.step === "gasBudget") {
    let parsedBudget;
    try {
      parsedBudget = parseGasBudgetInput(text);
    } catch (error) {
      await ctx.reply(error.message);
      return;
    }

    const { skipBudget, gasBudgetUsd } = parsedBudget;
    session.gasBudgetUsd = gasBudgetUsd;

    if (!session.stage) {
      await ctx.reply(
        "No mint stage selected. Please start the mint flow again.",
      );
      clearSession(chatId);
      return;
    }

    if (session.type === "fundMintTransfer") {
      session.step = "destination";
      await ctx.reply(
        "Enter the destination wallet address for the minted NFT(s).",
      );
      return;
    }

    if (isStageLive(session.stage)) {
      session.step = "confirmImmediate";
      const budgetSummary = skipBudget
        ? "Using network fee defaults"
        : `Gas budget set to $${Number(session.gasBudgetUsd).toFixed(2)} per wallet`;
      await ctx.reply(
        `${budgetSummary}.\n\nThis stage is already live. Fire the mint immediately? (yes/no)`,
      );
      return;
    }

    await ctx.reply(
      skipBudget
        ? "Using network fee defaults."
        : `Gas budget set to $${Number(session.gasBudgetUsd).toFixed(2)} per wallet.`,
    );
    await scheduleMintForStage(ctx, chatId, session);
    return;
  }

  if (session.step === "fundingKey") {
    if (text.length < 64) {
      await ctx.reply(
        "That does not look like a valid private key. Please try again.",
      );
      return;
    }

    try {
      session.encryptedFundingKey = encryptPrivateKey(text);
      session.step = "fundingAmount";
      await ctx.reply(
        "Enter the ETH amount to send to each mint wallet (for example: 0.0012).",
      );
    } catch (error) {
      await ctx.reply(`Could not protect the funding key: ${error.message}`);
      clearSession(chatId);
    }
    return;
  }

  if (session.step === "fundingAmount") {
    const fundingAmount = Number(text);
    if (!Number.isFinite(fundingAmount) || fundingAmount <= 0) {
      await ctx.reply("Please enter a valid positive ETH funding amount.");
      return;
    }

    session.fundingAmount = text;
    await scheduleFundMintTransfer(ctx, chatId, session);
    return;
  }

  if (session.step === "stage") {
    const stages = session.stages || [];
    const choice = Number(text);

    if (!Number.isInteger(choice) || choice < 1 || choice > stages.length) {
      await ctx.reply(`Please enter a number between 1 and ${stages.length}.`);
      return;
    }

    session.stage = stages[choice - 1];

    const encryptedKeys = session.encryptedKeys;
    if (!encryptedKeys || encryptedKeys.length === 0) {
      await ctx.reply(MISSING_WALLET_MESSAGE);
      return;
    }

    if (session.type === "fundMintTransfer") {
      session.mintTime = session.stage.start_time;
      session.step = "amount";
      await ctx.reply(
        `Selected stage: ${session.stage.label}\nMint time: ${session.mintTime}\n\nEnter the number of NFT(s) to mint per wallet.`,
      );
      return;
    }

    session.step = "amount";
    await ctx.reply(
      `Selected stage: ${session.stage.label}\n\nEnter the number of NFT(s) to mint per wallet.`,
    );
    return;
  }

  if (session.step === "confirmImmediate") {
    const answer = text.toLowerCase();
    if (answer !== "yes" && answer !== "no") {
      await ctx.reply("Please reply 'yes' or 'no'.");
      return;
    }

    if (answer === "no") {
      await ctx.reply("Mint canceled.");
      clearSession(chatId);
      return;
    }

    const privateKeys = await requireWalletKeys(ctx, session);
    if (!privateKeys) return;

    try {
      await ctx.reply("Starting mint immediately...");
      const overall = await mintWithWallets(
        privateKeys,
        session.slug,
        session.quantity,
        session.chain,
        undefined,
        session.stage,
        session.gasBudgetUsd,
        ctx.reply.bind(ctx),
      );
      await reportMintResults(ctx.reply.bind(ctx), overall);
      await ctx.reply("Mint execution completed!");
    } catch (error) {
      await ctx.reply(`Mint failed: ${error.message}`);
    }
    clearSession(chatId);
    return;
  }

  if (session.step === "addresses") {
    const addresses = text
      .split("\n")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);

    if (addresses.length === 0) {
      await ctx.reply("Please send at least one valid wallet address.");
      return;
    }

    const chain = session.chain;
    if (!chain) {
      await ctx.reply("Chain not set. Please start again.");
      clearSession(chatId);
      return;
    }

    try {
      const saved = await saveTrackedWallets(chatId, addresses, chain);
      session.step = "confirm";
      await ctx.reply(
        `Tracking ${saved.length} wallet(s) on ${chain}.\n\nSend "confirm" to start monitoring, or /cancel to abort.`,
      );
    } catch (err) {
      await ctx.reply(`Failed to save tracked wallets: ${err.message}`);
      clearSession(chatId);
    }
    return;
  }

  if (session.step === "confirm") {
    const answer = text.trim().toLowerCase();
    if (answer !== "confirm") {
      await ctx.reply('Send "confirm" to start, or /cancel to abort.');
      return;
    }

    try {
      await startMonitoring(chatId);
      await ctx.reply(
        `Monitoring active! Tracking ${session.encryptedKeys?.length || 0} bot wallet(s) and your specified addresses.`,
      );
    } catch (err) {
      await ctx.reply(`Failed to start monitoring: ${err.message}`);
    }
    clearSession(chatId);
    return;
  }
});

app.listen(PORT, () => {
  console.log(`Express server listening on port ${PORT}`);
});

bot.catch((err) => {
  console.error("Telegram bot error:", err);
});

bot.start();

resumeActiveMonitors().catch((err) => {
  console.error("Failed to resume monitors:", err);
});

console.log("Telegram mint bot running");
