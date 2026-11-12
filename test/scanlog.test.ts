import { describe, expect, it } from "vitest";
import { cleanSource, validWallet } from "../worker/scanlog";

describe("scan log input", () => {
  it("keeps only real 32-byte addresses", () => {
    expect(validWallet("B3BCTvv1LUpXZ2PpB4HeppxuSsS8Y1GSjYYG6NB6xTUA")).toBe("B3BCTvv1LUpXZ2PpB4HeppxuSsS8Y1GSjYYG6NB6xTUA");
    expect(validWallet("not an address")).toBeNull();
    expect(validWallet(42)).toBeNull();
    expect(validWallet("1111111111111111111111111111111111111111111111")).toBeNull();
  });
  it("keeps sources short and plain", () => {
    expect(cleanSource("Google.com")).toBe("google.com");
    expect(cleanSource("utm:chatgpt.com")).toBe("utm:chatgpt.com");
    expect(cleanSource("<script>x</script>")).toBe("scriptx/script");
    expect(cleanSource("x".repeat(200))?.length).toBe(80);
    expect(cleanSource(null)).toBeNull();
  });
});
