import mongoose from "mongoose";

let connected = false;

const botWalletSchema = new mongoose.Schema({
  chatId: { type: String, required: true, index: true },
  encryptedKey: { type: String, required: true },
  address: { type: String, required: true },
  chain: { type: String, required: true },
  active: { type: Boolean, default: true },
});

export const BotWallet = mongoose.model("BotWallet", botWalletSchema);

const trackedWalletSchema = new mongoose.Schema({
  chatId: { type: String, required: true, index: true },
  address: { type: String, required: true },
  chain: { type: String, required: true },
  lastCursor: { type: String, default: null },
  lastPolledAt: { type: Date, default: null },
  lastEventTimestamp: { type: String, default: null },
  active: { type: Boolean, default: true },
});

trackedWalletSchema.index({ chatId: 1, address: 1 }, { unique: true });

export const TrackedWallet = mongoose.model(
  "TrackedWallet",
  trackedWalletSchema,
);

export async function connectDb() {
  if (connected) return;
  await mongoose.connect(process.env.MONGODB_URI);
  connected = true;
}
