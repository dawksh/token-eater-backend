import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY environment variable is required");
}

const PRIVATE_KEY = process.env.PRIVATE_KEY.startsWith("0x")
  ? (process.env.PRIVATE_KEY as `0x${string}`)
  : (`0x${process.env.PRIVATE_KEY}` as `0x${string}`);

const TOKEN_POOL_ADDRESS = "0xF523972170E57bd0F9576fc2F310D586BC5914c6";
import { TokenPool } from "../TokenPool";

const abi = TokenPool;

const account = privateKeyToAccount(PRIVATE_KEY);

const client = createWalletClient({
  account,
  chain: monadTestnet,
  transport: http(),
});

const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(),
});

/**
 * Transfers all of user A's shares to user B in a TokenPool.
 *
 * @param {string} a - Address of user to transfer from
 * @param {string} b - Address of user to transfer to
 * @param {string} poolId - Pool identifier (not used in contract but useful for logging)
 */
export async function handleUserEat(a: string, b: string, gameId: string) {
  const poolId = "pool-1";
  console.log(`Transferring shares in pool ${poolId} from ${a} to ${b}`);

  try {
    // 1. Read share of 'a'
    const result = (await publicClient.readContract({
      address: TOKEN_POOL_ADDRESS,
      abi,
      functionName: "getUserInfo",
      args: [a],
    })) as [string, bigint];
    const [, share] = result;

    if (share === BigInt(0)) {
      throw new Error(`Address ${a} has no shares in pool ${poolId}.`);
    }

    // 2. Set a's share to 0
    await client.writeContract({
      address: TOKEN_POOL_ADDRESS,
      abi,
      functionName: "updateUserShare",
      args: [a, 0],
    });

    // 3. Assign share to b
    await client.writeContract({
      address: TOKEN_POOL_ADDRESS,
      abi,
      functionName: "updateUserShare",
      args: [b, share],
    });

    console.log(
      `✅ Transferred ${share} share points from ${a} to ${b} in pool ${poolId}`
    );
  } catch (e) {
    console.error(e);
  }
}

export function handleFoodEat(absoluteVal: number, eater: string): void {
  (async () => {
    try {
      const foodAbs = (await publicClient.readContract({
        address: TOKEN_POOL_ADDRESS,
        abi,
        functionName: "totalDeposits",
      })) as number; // in wei

      const food = (absoluteVal / foodAbs) * 100;

      const depositors = (await publicClient.readContract({
        address: TOKEN_POOL_ADDRESS,
        abi,
        functionName: "getAllDepositors",
      })) as readonly `0x${string}`[];

      const shares = await Promise.all(
        depositors.map(async (addr) => {
          const result = (await publicClient.readContract({
            address: TOKEN_POOL_ADDRESS,
            abi,
            functionName: "getUserInfo",
            args: [addr],
          })) as [string, bigint];
          const [, share] = result;
          return { address: addr.toLowerCase(), share };
        })
      );

      const eaterLower = eater.toLowerCase();
      const existing = shares.find((s) => s.address === eaterLower);

      if (!existing) {
        shares.push({ address: eaterLower, share: BigInt(0) });
      }

      const x = BigInt(food);
      const othersTotal = shares
        .filter((s) => s.address !== eaterLower)
        .reduce((sum, s) => sum + s.share, BigInt(0));

      if (x > othersTotal) {
        console.error("Not enough share to redistribute.");
        return;
      }

      const updatedShares = shares.map((s) => {
        if (s.address === eaterLower) {
          return { address: s.address, share: s.share + x };
        } else {
          const newShare = (s.share * (othersTotal - x)) / othersTotal;
          return { address: s.address, share: newShare };
        }
      });

      const users = updatedShares.map((s) => s.address as `0x${string}`);
      const newShares = updatedShares.map((s) => s.share);

      const { request } = await publicClient.simulateContract({
        address: TOKEN_POOL_ADDRESS,
        abi,
        functionName: "updateSharesBatch",
        args: [users, newShares],
        account: client.account,
      });

      const txHash = await client.writeContract(request);
      console.log(`✅ Shares updated successfully. Tx Hash: ${txHash}`);
    } catch (error) {
      console.error("❌ Error updating shares:", error);
    }
  })();
}

// export const transfer = (from: string, to: string, amount: number) => {};
