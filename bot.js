import dotenv from "dotenv";
import { Bot } from "grammy";
import { Menu } from "@grammyjs/menu";
import { Agenda } from "agenda";
import { MongoBackend } from "@agendajs/mongo-backend";
import { encryptPrivateKey } from "./lib/crypto.js";
import { startSession, getSession, clearSession } from "./lib/mintSession.js";
import { START_TEXT, HELP_TEXT } from "./lib/messages.js";
import { mintWithWallets } from "./mint.js";
import express from "express";
import { acceptBestOffer, listNfts, transferNFTs } from "./list.js";
import { getDecryptedKeys, reportResults, splitMintResults } from "./utils.js";

dotenv.config();

export const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

const app = express();

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Server is running and bot is polling!");
});

const agenda = new Agenda({
  backend: new MongoBackend({
    address: process.env.MONGODB_URI,
    collection: "agendaJobs",
  }),
  processEvery: "15 seconds",
  removeOnComplete: true,
});

agenda.define("mint", async (job) => {
  const { encryptedKeys, slug, quantity, chain, chatId, scheduleTime } =
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
      "Now send the target chain for minting (for example: ethereum, robinhood, base).",
    nextStep: "amount",
    nextPrompt: "Enter the amount of nft's you'd like to mint.",
  },
  sell: {
    chainPrompt:
      "Now send the target chain for selling (Mainnet, Robinhood, or Base).",
    nextStep: "slug",
    nextPrompt: "Enter the nft's opensea slug.",
  },
  transfer: {
    chainPrompt:
      "Now send the target chain for transferring the nfts (Mainnet, Robinhood, or Base).",
    nextStep: "slug",
    nextPrompt: "Enter the nft's opensea slug.",
  },
  list: {
    chainPrompt:
      "Now send the target chain for listing the nfts (Mainnet, Robinhood, or Base).",
    nextStep: "slug",
    nextPrompt: "Enter the nft's opensea slug.",
  },
};

const mainMenu = new Menu("main-menu");

for (const label of ["Mint", "Sell", "Transfer", "List"]) {
  mainMenu
    .text(label, async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      startSession(chatId, label.toLowerCase());
      await ctx.reply(
        "Please send your private key(s), one per line.\nSend /cancel to stop.",
      );
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
    await ctx.reply("Something went wrong. Start the process again");
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
      session.step = "schedule";
      await ctx.reply(
        "Enter the time to execute the mint.\nFormat: YYYY-MM-DD HH:mm\n(Example: 2024-12-25 14:30)\nOr type 'now' to run immediately.",
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
    const encryptedKeys = session.encryptedKeys;
    if (!encryptedKeys || encryptedKeys.length === 0) {
      await ctx.reply("Wallet data missing. Please start the process again.");
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
      await ctx.reply("Wallet data missing. Please start the process again.");
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
      await ctx.reply("Wallet data missing. Please start the process again.");
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

  if (session.step === "schedule") {
    const dateTimeStr = text.toLowerCase();
    const slug = session.slug;
    const encryptedKeys = session.encryptedKeys;

    if (!encryptedKeys || encryptedKeys.length === 0) {
      await ctx.reply("Wallet data missing. Please start the process again.");
      return;
    }

    if (dateTimeStr === "now") {
      try {
        await ctx.reply("Starting mint immediately...");
        const privateKeys = getDecryptedKeys(encryptedKeys);
        const overall = await mintWithWallets(
          privateKeys,
          slug,
          session.quantity,
          session.chain,
          chatId,
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

    const dateTimeRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
    if (!dateTimeRegex.test(dateTimeStr)) {
      await ctx.reply(
        "Invalid format. Please use: YYYY-MM-DD HH:mm (or type 'now')\n(Example: 2024-12-25 14:30)",
      );
      return;
    }

    try {
      const scheduleTime = new Date(dateTimeStr);
      const firingTime = new Date(dateTimeStr);
      firingTime.setSeconds(scheduleTime.getSeconds() - 30);

      if (firingTime <= new Date()) {
        await ctx.reply(
          "The scheduled time must be more than 30 seconds in the future.",
        );
        return;
      }

      await agenda.schedule(firingTime, "mint", {
        encryptedKeys,
        slug,
        quantity: session.quantity,
        chain: session.chain,
        chatId,
        scheduleTime,
      });

      const formattedTime = scheduleTime.toLocaleString();
      await ctx.reply(
        `Mint scheduled for ${formattedTime}.\n\n✓ ${encryptedKeys.length} wallet(s)\n✓ Slug: ${slug}\n✓ Chain: ${session.chain}`,
      );

      clearSession(chatId);
    } catch (error) {
      await ctx.reply(`Something went wrong: ${error}`);
    }
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
console.log("Telegram mint bot running");
