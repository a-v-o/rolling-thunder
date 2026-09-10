import { BASE_URL } from "../variables.js";

const getApiHeaders = () => ({
  "X-API-KEY": process.env.API_KEY,
  accept: "application/json",
});

const getErrorMessage = (data, fallback) =>
  (data.errors || []).join(", ") || fallback;

export async function getDrop(slug) {
  const response = await fetch(`${BASE_URL}/drops/${slug}`, {
    headers: getApiHeaders(),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      `Failed to fetch drop stages: HTTP ${response.status} ${getErrorMessage(data, response.statusText)}`,
    );
  }

  return response.json();
}

export async function getDropStages(slug) {
  const drop = await getDrop(slug);
  return drop.stages || [];
}

export function isStageLive(stage, now = new Date()) {
  if (!stage) return false;
  const start = stage.start_time ? new Date(stage.start_time) : null;
  const end = stage.end_time ? new Date(stage.end_time) : null;
  if (start && now < start) return false;
  if (end && now > end) return false;
  return true;
}

export async function getCollectionDetails(slug) {
  const response = await fetch(`${BASE_URL}/collections/${slug}`);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Failed to fetch collection: HTTP ${response.status} ${getErrorMessage(data, response.statusText)}`,
    );
  }

  return data;
}

export async function getMintPayload(
  walletAddress,
  quantity,
  slug,
  retries = 5,
) {
  try {
    const response = await fetch(`${BASE_URL}/drops/${slug}/mint`, {
      method: "POST",
      headers: {
        ...getApiHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        minter: walletAddress,
        quantity: Number(quantity),
      }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${getErrorMessage(data, response.statusText)}`,
      );
    }

    return data;
  } catch (error) {
    if (retries === 0) {
      throw new Error(`Failed to fetch mint payload: ${error.message}`, {
        cause: error,
      });
    }

    console.error(
      `Fetch failed for ${walletAddress}: ${error.message}. ${retries} retries left. Retrying in 1s...`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return getMintPayload(walletAddress, quantity, slug, retries - 1);
  }
}
