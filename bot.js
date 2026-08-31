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
  reportResults,
  splitMintResults,
} from "./lib/utils.js";
import { agenda } from "./agenda.js";
import {
  saveBotWalletsEncrypted,
  saveTrackedWallets,
  getTrackedWallets,
  deactivateTrackedWallets,
  clearBotWallets,
} from "./lib/walletStorage.js";
import {
  startMonitoring,
  stopMonitoring,
  resumeActiveMonitors,
} from "./monitor.js";

dotenv.config();

export const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

const app = express();

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Server is running and bot is polling!");
});

agenda.define("mint", async (job) => {
  const { encryptedKeys, slug, quantity, chain, chatId, scheduleTime, stage } =
    job.attrs.data;
  const sendMessage = (text) => bot.api.sendMessage(chatId, text);

  await sendMessage("Starting scheduled mint execution...");
  try {
    const privateKeys = getDecryptedKeys(encryptedKeys);
    const overall = await mintWithWallets(
      privateKeys,
      slug,
      quantity,
      chain,
      chatId,
      scheduleTime,
      stage,
    );
    await reportResults(sendMessage, splitMintResults(overall), "Mint");
    await sendMessage("Mint execution completed!");
  } catch (error) {
    await sendMessage(`Mint failed: ${error.message}`);
  }
});

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
};

const mainMenu = new Menu("main-menu");

for (const label of ["Mint", "Sell", "Transfer", "List", "Track"]) {
  mainMenu
    .text(label, async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      startSession(chatId, label.toLowerCase());
      const prompt =
        label === "Track"
          ? "Send your bot private key(s) for replay minting, one per line.\nSend /cancel to stop."
          : "Please send your private key(s), one per line.\nSend /cancel to stop.";
      await ctx.reply(prompt);
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
  await stopMonitoring(chatId);
  await deactivateTrackedWallets(chatId);
  await clearBotWallets(chatId);
  await ctx.reply("Monitoring stopped and all tracked wallets cleared.");
});

bot.command("wallets", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const wallets = await getTrackedWallets(chatId);
  if (!wallets || wallets.length === 0) {
    await ctx.reply("No wallets being tracked. Use the Track menu to start.");
    return;
  }
  const list = wallets.map((w) => `- ${w.address} (${w.chain})`).join("\n");
  await ctx.reply(`Tracked wallets:\n${list}`);
});

/**
 * Schedules a mint for a stage's own startTime — used when the selected
 * stage isn't live yet. Replaces manual date/time entry: the stage's start
 * time is the source of truth.
 */
async function scheduleMintForStage(ctx, chatId, session) {
  const { slug, chain, quantity, encryptedKeys, stage } = session;

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
    const keys = text
      .split("\n")
      .map((key) => key.trim())
      .filter((key) => key.length > 0);

    const validKeys = keys.filter((key) => key.length >= 64);

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

    if (session.type === "track" && session.encryptedKeys?.length > 0) {
      try {
        await saveBotWalletsEncrypted(
          chatId,
          session.encryptedKeys,
          session.chain,
        );
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

  if (session.step === "amount") {
    const quantity = Number(text);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      await ctx.reply("Please enter a valid positive number of nft's to mint.");
      return;
    }
    session.quantity = text;
    session.step = "slug";
    await ctx.reply("Enter the nft's opensea slug.");
    return;
  }

  if (session.step === "slug") {
    session.slug = text;

    if (session.type === "mint") {
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

      const stageList = stages
        .map((stage, i) => {
          const status = isStageLive(stage) ? "🟢 LIVE" : "⚪ not live";
          return (
            `${i + 1}. ${stage.label} (${status})\n` +
            `   Price: ${stage.price}  Max/wallet: ${stage.max_per_wallet}\n` +
            `   Start: ${stage.start_time}\n   End: ${stage.end_time}`
          );
        })
        .join("\n\n");

      await ctx.reply(`Select a mint stage by number:\n\n${stageList}`);
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
    const encryptedKeys = session.encryptedKeys;
    if (!encryptedKeys || encryptedKeys.length === 0) {
      await ctx.reply(
        "Wallet data missing. Please start the mint process again.",
      );
      return;
    }

    const privateKeys = getDecryptedKeys(encryptedKeys);
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
    const encryptedKeys = session.encryptedKeys;
    if (!encryptedKeys || encryptedKeys.length === 0) {
      await ctx.reply(
        "Wallet data missing. Please start the mint process again.",
      );
      return;
    }

    const privateKeys = getDecryptedKeys(encryptedKeys);
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
    const encryptedKeys = session.encryptedKeys;
    if (!encryptedKeys || encryptedKeys.length === 0) {
      await ctx.reply(
        "Wallet data missing. Please start the mint process again.",
      );
      return;
    }

    const privateKeys = getDecryptedKeys(encryptedKeys);
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
      await ctx.reply(
        "Wallet data missing. Please start the mint process again.",
      );
      return;
    }

    if (isStageLive(session.stage)) {
      session.step = "confirmImmediate";
      await ctx.reply(
        `Selected stage: ${session.stage.label}\n\nThis stage is already live. Fire the mint immediately? (yes/no)`,
      );
      return;
    }

    // Not live yet — schedule automatically for the stage's own start time,
    // no manual date/time entry needed.
    await ctx.reply(`Selected stage: ${session.stage.label}`);
    await scheduleMintForStage(ctx, chatId, session);
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

    const encryptedKeys = session.encryptedKeys;
    if (!encryptedKeys || encryptedKeys.length === 0) {
      await ctx.reply(
        "Wallet data missing. Please start the mint process again.",
      );
      return;
    }

    try {
      await ctx.reply("Starting mint immediately...");
      const privateKeys = getDecryptedKeys(encryptedKeys);
      const overall = await mintWithWallets(
        privateKeys,
        session.slug,
        session.quantity,
        session.chain,
        chatId,
        undefined,
        session.stage,
      );
      await reportResults(
        ctx.reply.bind(ctx),
        splitMintResults(overall),
        "Mint",
      );
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
