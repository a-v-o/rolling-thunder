import mongoose from "mongoose";

let connected = false;

const botWalletSchema = new mongoose.Schema({
  chatId: { type: String, required: true, index: true },
  encryptedKey: { type: String, required: true },
  address: { type: String, required: true },
  active: { type: Boolean, default: true },
});

export const BotWallet = mongoose.model("BotWallet", botWalletSchema);

const trackedWalletSchema = new mongoose.Schema({
  address: { type: String, required: true },
  subscriptions: [
    {
      chatId: { type: String, required: true },
      chains: { type: [String], default: [] },
    },
  ],
  lastPolledAt: { type: Date, default: null },
  lastEventTimestamp: { type: String, default: null },
});

trackedWalletSchema.index({ address: 1 }, { unique: true });

export const TrackedWallet = mongoose.model(
  "TrackedWallet",
  trackedWalletSchema,
);

export async function connectDb() {
  if (connected) return;
  await mongoose.connect(process.env.MONGODB_URI);
  connected = true;
}
