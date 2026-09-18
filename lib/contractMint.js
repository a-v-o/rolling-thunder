import { ethers } from "ethers";
import { RPC } from "../variables.js";

const ETHERSCAN_API_URL = "https://api.etherscan.io/v2/api";

function getEtherscanApiKey() {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) throw new Error("ETHERSCAN_API_KEY is not configured.");
  return apiKey;
}

function formatInput(input) {
  const type = input.type === "tuple" ? "tuple" : input.type;
  const suffix =
    input.internalType && input.internalType !== input.type
      ? ` (${input.internalType})`
      : "";
  return `${input.name || "unnamed"}: ${type}${suffix}`;
}

export function formatContractFunctions(abi) {
  return getMintFunctions(abi)
    .map((item, index) => {
      const inputs = item.inputs?.length
        ? item.inputs.map(formatInput).join(", ")
        : "no inputs";
      return `${index + 1}. ${item.name}(${inputs}) [${item.stateMutability}]`;
    })
    .join("\n");
}

export async function fetchContractAbi(address, chainId) {
  const normalizedAddress = ethers.getAddress(address);
  const params = new URLSearchParams({
    chainid: String(chainId),
    module: "contract",
    action: "getabi",
    address: normalizedAddress,
    apikey: getEtherscanApiKey(),
  });
  const response = await fetch(`${ETHERSCAN_API_URL}?${params}`);
  if (!response.ok) {
    throw new Error(`Etherscan request failed with HTTP ${response.status}.`);
  }

  const result = await response.json();
  if (result.status !== "1") {
    throw new Error(
      result.result ||
        "Etherscan could not find a verified ABI for this contract.",
    );
  }

  try {
    return JSON.parse(result.result);
  } catch {
    throw new Error("Etherscan returned an invalid ABI.");
  }
}

export function getMintFunctions(abi) {
  return abi.filter(
    (item) =>
      item.type === "function" &&
      item.stateMutability !== "view" &&
      item.stateMutability !== "pure",
  );
}

export function parseContractArguments(text, inputs) {
  if (inputs.length === 0) {
    if (text.trim() && text.trim().toLowerCase() !== "none") {
      throw new Error(
        "This function does not accept parameters. Reply 'none'.",
      );
    }
    return [];
  }

  let values;
  try {
    values = JSON.parse(text);
  } catch {
    throw new Error('Enter parameters as a JSON array, for example: ["1", 2].');
  }

  if (!Array.isArray(values) || values.length !== inputs.length) {
    throw new Error(`Expected ${inputs.length} parameter(s) in a JSON array.`);
  }
  return values;
}

export async function executeContractFunction({
  privateKey,
  chain,
  contractAddress,
  functionAbi,
  args,
  value,
}) {
  if (!RPC[chain]) throw new Error(`No RPC configured for chain: ${chain}`);
  const provider = new ethers.JsonRpcProvider(RPC[chain]);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(contractAddress, [functionAbi], wallet);
  const overrides = value ? { value: ethers.parseEther(value) } : {};
  const signature = `${functionAbi.name}(${functionAbi.inputs.map((input) => input.type).join(",")})`;
  const transaction = await contract.getFunction(signature)(...args, overrides);
  const receipt = await transaction.wait();

  return {
    address: wallet.address,
    success: receipt.status === 1,
    hash: transaction.hash,
    block: receipt.blockNumber,
  };
}
