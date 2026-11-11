// @solana/web3.js and @solana/spl-token expect Node's Buffer on the global. Imported first from main.ts so it
// is in place before those modules evaluate (ES module imports run in order).
import { Buffer } from "buffer";
(globalThis as any).Buffer ??= Buffer;
