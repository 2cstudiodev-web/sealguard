// pump.fun volume accounts: reading them, when SealGuard offers to close them, the instruction, and the fee.
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { parsePumpAccount, pumpAddress } from "../shared/chain";
import { PUMP_PROGRAMS, scan, SYSTEM_PROGRAM, type PumpAcct, type ScanInput } from "../web/src/scan";
import { buildTransaction, groupFee } from "../web/src/tx";

const W = "JCDrnFgRf2Edrcpr5mp7LxsNYWHxsyz1ryMi8pntstB2";
const base: ScanInput = { wallet: W, walletOwner: SYSTEM_PROGRAM, tokenAccounts: [], mints: {}, assets: {}, stakes: [], nonces: [] };
const pump = (p: Partial<PumpAcct>): PumpAcct => ({ program: "pump", address: "pda", lamports: 2_181_985, rent: 1_844_400, unclaimedTokens: 0n, needsClaim: false, heldTokens: 0, ...p });

/** Account data as the chain returns it: discriminator, user, needs_claim, total_unclaimed_tokens, then zeros up to 137 bytes. */
function accountData(user: string, needsClaim: boolean, unclaimed: bigint): string {
  const b = new Uint8Array(137);
  b.set([86, 255, 112, 14, 102, 53, 154, 250], 0);
  b.set(new PublicKey(user).toBytes(), 8);
  b[40] = needsClaim ? 1 : 0;
  new DataView(b.buffer).setBigUint64(41, unclaimed, true);
  return btoa(String.fromCharCode(...b));
}

describe("pump.fun deposits", () => {
  it("derives the same PDAs pump.fun uses", () => {
    expect(pumpAddress("pump", W)).toBe(PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), new PublicKey(W).toBuffer()], new PublicKey(PUMP_PROGRAMS.pump.id))[0].toBase58());
    expect(pumpAddress("pump", W)).not.toBe(pumpAddress("pumpswap", W));
  });

  it("reads the account: rent from its size, rewards still to claim, and rejects another program's or wallet's data", () => {
    const a = { owner: PUMP_PROGRAMS.pump.id, lamports: 2_181_985, data: [accountData(W, false, 0n), "base64"] };
    expect(parsePumpAccount("pump", "pda", W, a)).toMatchObject({ rent: 1_844_400, lamports: 2_181_985, needsClaim: false, unclaimedTokens: 0n });
    expect(parsePumpAccount("pump", "pda", W, { ...a, data: [accountData(W, true, 5n), "base64"] })).toMatchObject({ needsClaim: true, unclaimedTokens: 5n });
    expect(parsePumpAccount("pump", "pda", W, { ...a, owner: SYSTEM_PROGRAM })).toBeNull();
    expect(parsePumpAccount("pump", "pda", W, { ...a, data: [accountData("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", false, 0n), "base64"] })).toBeNull();
    expect(parsePumpAccount("pump", "pda", W, null)).toBeNull();
  });

  it("offers to close when nothing is left to claim, unticked with a reason, and mentions the SOL cashback", () => {
    const r = scan({ ...base, pump: [pump({})] });
    const f = r.findings.find((x) => x.check === "pumpDeposit")!;
    expect(f.action).toMatchObject({ kind: "closePump", program: "pump", lamports: 2_181_985, rent: 1_844_400 });
    expect(f.keep).toMatch(/next trade/);
    expect(f.detail).toMatch(/SOL cashback/);
    expect(r.score).toBe(100);
  });

  it("leaves it to pump.fun while rewards or token cashback are unclaimed", () => {
    for (const p of [pump({ unclaimedTokens: 1n }), pump({ needsClaim: true }), pump({ heldTokens: 1 })]) {
      const f = scan({ ...base, pump: [p] }).findings[0];
      expect(f.action).toBeUndefined();
      expect(f.detail).toMatch(/Claim them on pump.fun first/);
    }
  });

  it("builds the close instruction and charges the fee on the deposit only, not the cashback", () => {
    const a = scan({ ...base, pump: [pump({ address: pumpAddress("pump", W) })] }).findings[0].action!;
    expect(groupFee([a], 500)).toBe(Math.floor((1_844_400 * 500) / 10_000));
    const tx = buildTransaction([a], new PublicKey(W), "11111111111111111111111111111111", 1, { feeBps: 500 });
    const ix = tx.instructions[0];
    expect(ix.programId.toBase58()).toBe(PUMP_PROGRAMS.pump.id);
    expect([...ix.data]).toEqual([249, 69, 164, 218, 150, 103, 84, 138]);
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([[true, true], [false, true], [false, false], [false, false]]);
    expect(tx.instructions).toHaveLength(2); // the close, then the fee transfer
  });
});
