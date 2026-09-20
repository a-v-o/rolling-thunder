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

function parseJsonValue(text, input) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Enter ${input.name || "this value"} as valid JSON.`);
  }

  const arrayMatch = input.type.match(/^(.*)\[(\d*)\]$/);
  if (arrayMatch) {
    if (!Array.isArray(value)) {
      throw new Error(`${input.name || "This value"} must be a JSON array.`);
    }
    if (arrayMatch[2] && value.length !== Number(arrayMatch[2])) {
      throw new Error(
        `${input.name || "This value"} must contain ${arrayMatch[2]} item(s).`,
      );
    }
    const itemInput = { ...input, type: arrayMatch[1] };
    return value.map((item) =>
      parseContractArgument(JSON.stringify(item), itemInput),
    );
  }

  if (input.type === "tuple") {
    if (!Array.isArray(value) || value.length !== input.components.length) {
      throw new Error(
        `${input.name || "This value"} must contain ${input.components.length} item(s).`,
      );
    }
    return value.map((item, index) =>
      parseContractArgument(JSON.stringify(item), input.components[index]),
    );
  }

  return value;
}

export function parseContractArgument(text, input) {
  const type = input.type;
  const value = text.trim();

  if (type.endsWith("]") || type === "tuple") {
    return parseJsonValue(text, input);
  }

  if (type === "bool") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
    throw new Error(`${input.name || "This value"} must be true or false.`);
  }

  if (type === "address") {
    try {
      return ethers.getAddress(value);
    } catch {
      throw new Error(`${input.name || "This value"} must be a valid address.`);
    }
  }

  if (/^u?int\d*$/.test(type) && !/^[+-]?\d+$/.test(value)) {
    throw new Error(`${input.name || "This value"} must be an integer.`);
  }

  if (/^uint\d*$/.test(type) && value.startsWith("-")) {
    throw new Error(`${input.name || "This value"} cannot be negative.`);
  }

  if (
    /^bytes\d+$/.test(type) &&
    !new RegExp(`^0x[0-9a-fA-F]{${Number(type.slice(5)) * 2}}$`).test(value)
  ) {
    throw new Error(`${input.name || "This value"} must be ${type}.`);
  }

  if (type === "bytes" && !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new Error(
      `${input.name || "This value"} must be a hex value starting with 0x.`,
    );
  }

  if (type === "string") {
    return value.startsWith('"') && value.endsWith('"')
      ? JSON.parse(value)
      : text;
  }

  return value;
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
