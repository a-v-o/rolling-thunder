import { mintWithWallets } from "../mint.js";
import { getDecryptedKeys, reportMintResults } from "./utils.js";

export function registerMintJob(agenda, bot) {
  agenda.define("mint", async (job) => {
    const {
      encryptedKeys,
      slug,
      quantity,
      chain,
      chatId,
      scheduleTime,
      stage,
      gasBudgetUsd,
    } = job.attrs.data;
    const sendMessage = (text) => bot.api.sendMessage(chatId, text);

    await sendMessage("Starting scheduled mint execution...");
    try {
      const privateKeys = getDecryptedKeys(encryptedKeys);
      const overall = await mintWithWallets(
        privateKeys,
        slug,
        quantity,
        chain,
        scheduleTime,
        stage,
        gasBudgetUsd,
        sendMessage,
      );
      await reportMintResults(sendMessage, overall);
      await sendMessage("Mint execution completed!");
    } catch (error) {
      await sendMessage(`Mint failed: ${error.message}`);
    }
  });
}
