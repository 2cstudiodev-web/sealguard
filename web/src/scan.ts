// SealGuard scan rules. Pure functions: everything the chain told us comes in as plain data (see rpc.ts) and
// findings come out. No network, no wallet, so the rules are unit-tested in test/scan.test.ts.

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export type TokenProgram = "token" | "token2022";

export type TokenAcct = {
  address: string;
  mint: string;
  program: TokenProgram;
  amount: bigint;
  decimals: number;
  delegate: string | null;
  delegatedAmount: bigint;
  closeAuthority: string | null;
  frozen: boolean;
  /** Wrapped SOL account: closing it returns the SOL itself, not just rent. */
  isNative: boolean;
};

export type MintInfo = {
  mint: string;
  /** Token-2022 extension names as the RPC reports them (permanentDelegate, transferHook, nonTransferable, defaultAccountState…). */
  extensions: string[];
  permanentDelegate: string | null;
  /** defaultAccountState extension's state, "frozen" when new accounts start frozen. */
  defaultState: string | null;
};

/** What the DAS API knows about an asset the wallet holds (name, symbol, link), for the phishing rules. */
export type AssetMeta = {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  jsonUri: string;
  /** DAS interface: "FungibleToken", "FungibleAsset", "V1_NFT", "ProgrammableNFT", "V2_ASSET"… */
  kind: string;
  /** Known on a price feed (DAS token_info.price_info present): a token with a market is not a phishing bait. */
  priced: boolean;
};

export type StakeAcct = { address: string; staker: string; withdrawer: string; lamports: number };
export type NonceAcct = { address: string; authority: string; lamports: number };

export type ScanInput = {
  wallet: string;
  /** Owner program of the wallet account itself; anything but the System Program means the wallet is lost. */
  walletOwner: string;
  tokenAccounts: TokenAcct[];
  mints: Record<string, MintInfo>;
  assets: Record<string, AssetMeta>;
  stakes: StakeAcct[];
  nonces: NonceAcct[];
  /** Checks that couldn't run (provider limits); shown so "nothing found" isn't mistaken for "all checked". */
  warnings?: string[];
};

export type Severity = "critical" | "high" | "medium" | "low" | "ok";

export type CheckId =
  | "owner"
  | "delegate"
  | "permanentDelegate"
  | "mintExtensions"
  | "closeAuthority"
  | "frozen"
  | "empty"
  | "phishing"
  | "stake"
  | "nonce";

export type Action =
  | { kind: "revoke"; tokenAccount: string; mint: string; program: TokenProgram }
  | { kind: "close"; tokenAccount: string; mint: string; program: TokenProgram }
  | { kind: "burnClose"; tokenAccount: string; mint: string; program: TokenProgram; amount: bigint }
  | { kind: "withdrawNonce"; nonceAccount: string; lamports: number };

export type Finding = {
  check: CheckId;
  severity: Severity;
  title: string;
  detail: string;
  /** Accounts involved, for the explorer links. */
  accounts: string[];
  /** What one tap can do about it; absent when only you can decide (or nothing can be done). */
  action?: Action;
};

export type ScanResult = {
  score: number;
  findings: Finding[];
  /** How many of each severity, for the summary line. */
  counts: Record<Severity, number>;
  /** Plain-language summary of what was looked at, so "nothing found" still shows something was checked. */
  checked: { tokenAccounts: number; mints: number; stakes: number; nonces: number };
  warnings: string[];
};

const PENALTY: Record<Severity, number> = { critical: 100, high: 25, medium: 10, low: 2, ok: 0 };

/**
 * Points off for the findings. Ten approvals are worse than one, but not ten times worse, so within one check
 * the first finding counts in full and each further one a quarter, up to twice the single penalty.
 */
export function scorePenalty(findings: Finding[]): number {
  const groups = new Map<string, { sev: Severity; n: number }>();
  for (const x of findings) {
    const key = `${x.check}:${x.severity}`;
    const g = groups.get(key);
    if (g) g.n++; else groups.set(key, { sev: x.severity, n: 1 });
  }
  let total = 0;
  for (const g of groups.values()) {
    const base = PENALTY[g.sev];
    total += Math.min(base * 2, base * (1 + 0.25 * (g.n - 1)));
  }
  return total;
}

/** The lamports a token account's rent deposit is worth (0.00203928 SOL for a 165-byte account). */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;

const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|io|xyz|app|net|org|fi|gg|co|site|link|me|lol|wtf|fun)\b|t\.me\/)/i;
const BAIT_RE = /\b(claim|reward|rewards|airdrop|bonus|voucher|gift|prize|redeem|winner|free)\b/i;

export function looksLikePhishing(a: AssetMeta): string | null {
  if (a.priced) return null;
  const text = `${a.name} ${a.symbol} ${a.description}`;
  if (URL_RE.test(text)) return "its name or description contains a web address";
  if (URL_RE.test(a.jsonUri) && /t\.me\/|claim|reward|airdrop/i.test(a.jsonUri)) return "its metadata link points at a claim page";
  if (BAIT_RE.test(a.name) || BAIT_RE.test(a.symbol)) return "its name reads like a claim or reward";
  return null;
}

export function shortKey(k: string): string {
  return k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : k;
}

export function formatAmount(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function assetName(mint: string, assets: Record<string, AssetMeta>): string {
  const a = assets[mint];
  if (a && (a.name || a.symbol)) return a.symbol ? `${a.name || a.symbol} (${a.symbol})` : a.name;
  return shortKey(mint);
}

export function scan(input: ScanInput): ScanResult {
  const f: Finding[] = [];
  const { wallet, tokenAccounts, mints, assets } = input;

  // 1. The wallet account itself. An attacker who got a signature can reassign the account's owner to a program;
  //    after that the System Program can't move its SOL and every future signature is worthless.
  if (input.walletOwner && input.walletOwner !== SYSTEM_PROGRAM) {
    f.push({
      check: "owner", severity: "critical",
      title: "Your wallet account's owner has been changed",
      detail: `The account is now owned by program ${shortKey(input.walletOwner)} instead of the System Program. This is what wallet drainers do once they have a signature. Move everything you still can to a brand-new wallet and stop using this one.`,
      accounts: [wallet, input.walletOwner],
    });
  }

  for (const t of tokenAccounts) {
    const name = assetName(t.mint, assets);
    const mint = mints[t.mint];

    // 2. Delegates: someone else may transfer or burn up to delegatedAmount from this account.
    if (t.delegate) {
      const live = t.delegatedAmount > 0n && t.amount > 0n;
      f.push({
        check: "delegate", severity: live ? "high" : "low",
        title: live ? `${shortKey(t.delegate)} can spend your ${name}` : `Stale approval on ${name}`,
        detail: live
          ? `An approval lets ${shortKey(t.delegate)} move up to ${formatAmount(t.delegatedAmount, t.decimals)} ${assets[t.mint]?.symbol || ""} without asking you again. If you don't know why it's there, revoke it.`
          : `An approval for ${shortKey(t.delegate)} is still recorded but there is nothing it could take right now. Revoking it keeps things tidy.`,
        accounts: [t.address, t.delegate],
        action: { kind: "revoke", tokenAccount: t.address, mint: t.mint, program: t.program },
      });
    }

    // 3. Token-2022 extensions on the mint.
    if (mint) {
      if (mint.permanentDelegate && t.amount > 0n) {
        // Tokenised stocks and other regulated tokens use a permanent delegate on purpose; a token with a market
        // price is almost always one of those, so it's a note, not an alarm. An unpriced one deserves a look.
        const known = Boolean(assets[t.mint]?.priced);
        f.push({
          check: "permanentDelegate", severity: known ? "low" : "medium",
          title: `The issuer of ${name} can take it back any time`,
          detail: `This token has a permanent delegate (${shortKey(mint.permanentDelegate)}): that address can transfer or burn it from your wallet without your signature, and nothing can revoke that. ${known ? "Regulated tokens such as tokenised stocks work this way by design; nothing to do unless you don't trust the issuer." : "Some regulated tokens use it legitimately. If you don't trust the issuer, sell or move it out, or burn it."}`,
          accounts: [t.address, t.mint, mint.permanentDelegate],
          action: { kind: "burnClose", tokenAccount: t.address, mint: t.mint, program: t.program, amount: t.amount },
        });
      }
      const odd = mint.extensions.filter((e) => e === "transferHook" || e === "nonTransferable" || (e === "defaultAccountState" && mint.defaultState === "frozen"));
      if (odd.length && t.amount > 0n) {
        const words = odd.map((e) => (e === "transferHook" ? "a transfer hook (a program runs on every transfer and can block it)" : e === "nonTransferable" ? "non-transferable (it can never leave this wallet)" : "frozen by default")).join(", ");
        f.push({
          check: "mintExtensions", severity: "medium",
          title: `${name} has restrictions built in`,
          detail: `The token is ${words}. That's not an attack by itself, but it's how some scam tokens trap you: you can receive them and never sell them.`,
          accounts: [t.address, t.mint],
        });
      }
    }

    // 4. Someone else can close the account (only once it's empty, but then they keep the rent).
    if (t.closeAuthority && t.closeAuthority !== wallet) {
      f.push({
        check: "closeAuthority", severity: "low",
        title: `${shortKey(t.closeAuthority)} may close your ${name} account`,
        detail: `Once the account is empty, that address can close it and keep the rent deposit. Usually harmless; it comes from how the account was created.`,
        accounts: [t.address, t.closeAuthority],
      });
    }

    // 5. Frozen by the issuer.
    if (t.frozen && t.amount > 0n) {
      f.push({
        check: "frozen", severity: "medium",
        title: `Your ${name} is frozen`,
        detail: `The token's issuer froze this account: you can't move or sell it until they unfreeze it.`,
        accounts: [t.address, t.mint],
      });
    }

    // 6. Empty accounts: closing them returns the rent deposit (about 0.002 SOL each).
    if (t.amount === 0n && !t.frozen) {
      f.push({
        check: "empty", severity: "ok",
        title: t.isNative ? "Empty wrapped-SOL account" : `Empty ${name} account`,
        detail: `Nothing in it. Closing it returns the ${formatAmount(BigInt(TOKEN_ACCOUNT_RENT_LAMPORTS), 9)} SOL deposit to you.`,
        accounts: [t.address],
        action: { kind: "close", tokenAccount: t.address, mint: t.mint, program: t.program },
      });
    }

    // 7. Phishing airdrops: tokens whose name is a web address or a "claim your reward" line.
    const a = assets[t.mint];
    if (a && t.amount > 0n) {
      const why = looksLikePhishing(a);
      if (why) {
        const nft = /NFT|V2_ASSET/i.test(a.kind) || (t.decimals === 0 && t.amount === 1n);
        f.push({
          check: "phishing", severity: "medium",
          title: `${a.name || shortKey(t.mint)} looks like a phishing airdrop`,
          detail: `You didn't buy this: ${why}. Never open the link; the site asks for a signature that empties the wallet. ${nft ? "It's an NFT, so burn it from your wallet app (SealGuard only burns fungible tokens for now)." : "You can burn it and close the account to get the rent back."}`,
          accounts: [t.address, t.mint],
          action: nft ? undefined : { kind: "burnClose", tokenAccount: t.address, mint: t.mint, program: t.program, amount: t.amount },
        });
      }
    }
  }

  // 8. Stake accounts: the withdrawer is the one who can take the SOL out.
  for (const s of input.stakes) {
    if (s.staker === wallet && s.withdrawer !== wallet) {
      f.push({
        check: "stake", severity: "high",
        title: `Someone else can withdraw your stake account ${shortKey(s.address)}`,
        detail: `You can stake and unstake it, but ${shortKey(s.withdrawer)} holds the withdraw authority: they, not you, can take the ${formatAmount(BigInt(s.lamports), 9)} SOL out. If you didn't set this up on purpose, move the withdraw authority back to yourself in your wallet or staking app.`,
        accounts: [s.address, s.withdrawer],
      });
    } else if (s.withdrawer === wallet && s.staker !== wallet) {
      f.push({
        check: "stake", severity: "low",
        title: `${shortKey(s.staker)} manages your stake account ${shortKey(s.address)}`,
        detail: `They can delegate and deactivate it; only you can withdraw. Common with staking services.`,
        accounts: [s.address, s.staker],
      });
    }
  }

  // 9. Durable nonce accounts: a drainer can pre-sign a transfer that never expires and send it weeks later.
  for (const n of input.nonces) {
    f.push({
      check: "nonce", severity: "medium",
      title: `A durable nonce account is tied to your wallet (${shortKey(n.address)})`,
      detail: `Nonce accounts let a transaction be signed now and sent much later. Developers use them on purpose; drainers use them to replay a transfer after you think you're safe. If you didn't create it, withdraw it, which also takes back its ${formatAmount(BigInt(n.lamports), 9)} SOL.`,
      accounts: [n.address],
      action: { kind: "withdrawNonce", nonceAccount: n.address, lamports: n.lamports },
    });
  }

  const order: Severity[] = ["critical", "high", "medium", "low", "ok"];
  f.sort((x, y) => order.indexOf(x.severity) - order.indexOf(y.severity));
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, ok: 0 };
  for (const x of f) counts[x.severity]++;
  const score = Math.max(0, 100 - scorePenalty(f));
  return {
    score, findings: f, counts,
    checked: { tokenAccounts: tokenAccounts.length, mints: Object.keys(mints).length, stakes: input.stakes.length, nonces: input.nonces.length },
    warnings: input.warnings ?? [],
  };
}
