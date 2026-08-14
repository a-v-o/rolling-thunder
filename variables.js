import dotenv from "dotenv";
dotenv.config();

export const BASE_URL = "https://api.opensea.io/api/v2";

export const RPC = {
  ethereum: process.env.ETHEREUM_RPC_URL,
  robinhood: process.env.ROBINHOOD_RPC_URL,
  base: process.env.BASE_RPC_URL,
};
