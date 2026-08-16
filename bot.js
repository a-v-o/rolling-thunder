import dotenv from "dotenv";
import { Bot } from "grammy";
import { Menu } from "@grammyjs/menu";
import { Agenda } from "agenda";
import { MongoBackend } from "@agendajs/mongo-backend";
import { encryptPrivateKey, decryptPrivateKey } from "./lib/crypto.js";
import { startSession, getSession, clearSession } from "./lib/mintSession.js";
import { START_TEXT, HELP_TEXT, UNSUPPORTED_TEXT } from "./lib/messages.js";
import { mintWithWallets } from "./mint.js";
import express from "express";
import { acceptBestOffer } from "./list.js";

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
  bot.api.sendMessage(chatId, "Starting scheduled mint execution...");
  try {
    // Decrypt private keys
    const privateKeys = encryptedKeys.map((encryptedKey) =>
      decryptPrivateKey(encryptedKey),
    );
    const overall = await mintWithWallets(
      privateKeys,
      slug,
      quantity,
      chain,
      chatId,
      scheduleTime,
    );
    overall.forEach((result) => {
      if (result.success) {
        bot.api.sendMessage(
          chatId,
          `• ${result.privateKey.slice(0, 10)}... : OK (${result.hash} @ ${result.block})`,
        );
      } else {
        bot.api.sendMessage(
          chatId,
          `• ${result.privateKey.slice(0, 10)}... : FAIL (${result.error})`,
        );
      }
    });
    await bot.api.sendMessage(chatId, "Mint execution completed!");
  } catch (error) {
    await bot.api.sendMessage(chatId, `Mint failed: ${error.message}`);
  }
});

await agenda.start();

const mainMenu = new Menu("main-menu");

mainMenu
  .text("Mint", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    startSession(chatId, "mint");
    await ctx.reply(
      "Please send your private key(s), one per line.\nSend /cancel to stop.",
    );
  })
  .row();

mainMenu
  .text("Sell", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    startSession(chatId, "sell");
    await ctx.reply(
      "Please send your private key(s), one per line.\nSend /cancel to stop.",
    );
  })
  .row();

// mainMenu
//   .text("List", async (ctx) => {

//   })
//   .row();

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
  if (session) {
    if (text.startsWith("/")) {
      if (text.toLowerCase() === "/cancel") {
        clearSession(chatId);
        await ctx.reply("Mint request canceled.");
      }
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

      // Encrypt private keys
      const encryptedKeys = validKeys.map((key) => encryptPrivateKey(key));
      session.encryptedKeys = encryptedKeys;

      if (session.type == "mint") {
        await ctx.reply(
          `Imported ${validKeys.length} wallet(s).\nNow send the target chain for minting (for example: ethereum, robinhood, base).`,
        );
        session.step = "chain";
      } else if (session.type == "sell") {
        await ctx.reply(
          `Imported ${validKeys.length} wallet(s).\nNow send the target chain for selling (Mainnet, Robinhood, or Base).`,
        );
        session.step = "chain";
      } else {
        await ctx.reply("Something went wrong. Start the mint process again");
        clearSession(chatId);
      }

      return;
    }

    if (session.step === "chain") {
      if (session.type == "mint") {
        session.chain = text.toLowerCase();
        session.step = "amount";
        await ctx.reply("Enter the amount of nft's you'd like to mint.");
      } else if (session.type == "sell") {
        session.chain = text.toLowerCase();
        session.step = "slug";
        await ctx.reply("Enter the nft's opensea slug.");
      } else {
        await ctx.reply("Something went wrong. Start the mint process again");
        clearSession(chatId);
      }
      return;
    }

    if (session.step === "amount") {
      session.quantity = text;
      session.step = "slug";
      await ctx.reply("Enter the nft's opensea slug.");
      return;
    }

    if (session.step === "slug") {
      if (session.type == "mint") {
        session.slug = text;
        session.step = "schedule";
        await ctx.reply(
          "Enter the time to execute the mint.\nFormat: YYYY-MM-DD HH:mm\n(Example: 2024-12-25 14:30)\nOr type 'now' to run immediately.",
        );
      } else if (session.type == "sell") {
        session.slug = text;
        const encryptedKeys = session.encryptedKeys;
        if (!encryptedKeys || encryptedKeys.length === 0) {
          await ctx.reply(
            "Wallet data missing. Please start the mint process again.",
          );
          return;
        }

        const privateKeys = encryptedKeys.map((encryptedKey) =>
          decryptPrivateKey(encryptedKey),
        );

        const { success, fail } = await acceptBestOffer(
          privateKeys,
          session.slug,
          session.chain,
        );
        if (success.length !== 0) {
          for (const wallet of success) {
            await ctx.reply(
              `- ${wallet.pk.slice(0, 12)}... successful. TX hash: ${wallet.txHash}`,
            );
          }
        }

        if (fail.length !== 0) {
          for (const wallet of fail) {
            await ctx.reply(
              `- ${wallet.pk.slice(0, 12)}... failed. Reason: ${wallet.err}.`,
            );
          }
          await ctx.reply("All failed pks are below so you can retry");
          const failedPks = fail.map((wallet) => wallet.pk);
          await ctx.reply(failedPks.join("\n"));
        }
      }

      return;
    }

    if (session.step === "schedule") {
      const dateTimeStr = text.toLowerCase();
      const slug = session.slug;
      const encryptedKeys = session.encryptedKeys;

      if (!encryptedKeys || encryptedKeys.length === 0) {
        await ctx.reply(
          "Wallet data missing. Please start the mint process again.",
        );
        return;
      }

      // Check if user wants to run immediately
      if (dateTimeStr === "now") {
        try {
          await ctx.reply("Starting mint immediately...");

          // Decrypt private keys
          const privateKeys = encryptedKeys.map((encryptedKey) =>
            decryptPrivateKey(encryptedKey),
          );

          const overall = await mintWithWallets(
            privateKeys,
            slug,
            session.quantity,
            session.chain,
            chatId,
          );
          overall.forEach(async (result) => {
            if (result.success) {
              await ctx.reply(
                `• ${result.privateKey.slice(0, 10)}... : OK (${result.hash} @ ${result.block})`,
              );
            } else {
              await ctx.reply(
                `• ${result.privateKey.slice(0, 10)}... : FAIL (${result.error})`,
              );
            }
          });
          await ctx.reply("Mint execution completed!");
        } catch (error) {
          await ctx.reply(`Mint failed: ${error.message}`);
        }
        clearSession(chatId);
        return;
      }

      // Validate date format YYYY-MM-DD HH:mm
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
        // Schedule 30 seconds earlier
        firingTime.setSeconds(scheduleTime.getSeconds() - 30);

        // Validate that the date is in the future
        if (firingTime <= new Date()) {
          await ctx.reply(
            "The scheduled time must be more than 30 seconds in the future.",
          );
          return;
        }

        // Schedule the mint job
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
        await ctx.reply(
          `Invalid date/time format. Please use: YYYY-MM-DD HH:mm (or type 'now')\n(Example: 2024-12-25 14:30)`,
        );
      }
      return;
    }
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
