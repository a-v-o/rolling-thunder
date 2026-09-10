import { fundMintAndTransfer } from "./fundMintTransfer.js";
import { getDecryptedKeys, reportResults, splitMintResults } from "./utils.js";

export function registerFundMintTransferJob(agenda, bot) {
  agenda.define("fundMintTransfer", async (job) => {
    const {
      encryptedKeys,
      encryptedFundingKey,
      destination,
      slug,
      quantity,
      chain,
      mintTime,
      stage,
      chatId,
    } = job.attrs.data;
    const sendMessage = (text) => bot.api.sendMessage(chatId, text);

    await sendMessage(
      "Starting scheduled fund, mint, and transfer execution...",
    );
    try {
      const result = await fundMintAndTransfer({
        privateKeys: getDecryptedKeys(encryptedKeys),
        fundingPrivateKey: getDecryptedKeys([encryptedFundingKey])[0],
        destination,
        slug,
        quantity,
        chain,
        mintTime,
        stage,
        sendMessage,
      });
      await reportResults(
        sendMessage,
        splitMintResults(result.mintResults),
        "Mint",
      );
      await sendMessage(
        `Transferred ${result.transfers.length} NFT(s) to ${destination}.`,
      );
    } catch (error) {
      await sendMessage(`Fund, mint, and transfer failed: ${error.message}`);
    }
  });
}
