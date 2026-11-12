// NFT burns: listed with what they return, never ticked by default, fee on the rent they return.
import { describe, expect, it } from "vitest";
import { NFT_KEEP, rentOf, scan, SYSTEM_PROGRAM, type NftRent, type ScanInput, type TokenAcct } from "../web/src/scan";

const W = "7Lk1W1R8rz8ZYzvYc7Yx7oqk9kV1uC2Q7u7eQ2Q6n2Qe";
const acct = (p: Partial<TokenAcct>): TokenAcct => ({ address: "ta", mint: "nft", program: "token", amount: 1n, decimals: 0, delegate: null, delegatedAmount: 0n, closeAuthority: null, frozen: false, isNative: false, ...p });
const nft = (p: Partial<NftRent> = {}): NftRent => ({ mint: "nft", tokenAccount: "ta", metadata: "md", edition: "ed", pnft: false, name: "Cool Cat", lamports: 5_970_000, ...p });
const input = (p: Partial<ScanInput>): ScanInput => ({ wallet: W, walletOwner: SYSTEM_PROGRAM, tokenAccounts: [acct({})], mints: {}, assets: {}, stakes: [], nonces: [], ...p });

describe("NFT burns", () => {
  it("lists an NFT that holds rent, unticked, with what it returns", () => {
    const r = scan(input({ nfts: [nft()] }), { closeFeeBps: 500 });
    const f = r.findings.find((x) => x.check === "nftRent")!;
    expect(f.title).toBe("NFT you could burn: Cool Cat");
    expect(f.keep).toBe(NFT_KEEP);
    expect(f.action).toMatchObject({ kind: "burnNft", tokenAccount: "ta", metadata: "md", edition: "ed", lamports: 5_970_000 });
    expect(rentOf(f.action!)).toBe(5_970_000);
  });
  it("offers a burn on a phishing NFT, still unticked, and doesn't list it twice", () => {
    const assets = { nft: { mint: "nft", name: "claim-rewards.xyz Airdrop", symbol: "", description: "", jsonUri: "", kind: "V1_NFT", priced: false } };
    const r = scan(input({ nfts: [nft()], assets }), { closeFeeBps: 500 });
    expect(r.findings.filter((x) => x.action?.kind === "burnNft")).toHaveLength(1);
    const f = r.findings.find((x) => x.check === "phishing")!;
    expect(f.action?.kind).toBe("burnNft");
    expect(f.keep).toBe(NFT_KEEP);
    expect(f.detail).toContain("Burning it returns about");
  });
});
