// The page reads the chain through SealGuard's own /rpc relay (the provider key stays on the server; see
// worker/index.ts). The actual reading lives in shared/chain.ts, which the Worker's guard cron uses too.
import { fetchScanInput as fetchWith, rpcOver, type Progress } from "../../shared/chain";
import type { ScanInput } from "./scan";

export { RpcError } from "../../shared/chain";

/** One RPC call may take this long; a stuck provider should fail the scan, not hang it. */
export const RPC_TIMEOUT_MS = 30_000;

export const rpc = rpcOver("/rpc", RPC_TIMEOUT_MS);

export function fetchScanInput(wallet: string, onProgress: Progress = () => {}): Promise<ScanInput> {
  return fetchWith(rpc, wallet, onProgress);
}
