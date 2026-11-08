import { describe, expect, it } from "vitest";
import { qrPath } from "../src/components/QrCode.tsx";

describe("QR code for the phone", () => {
  it("encodes an address into a square of modules", () => {
    const { size, d } = qrPath("https://dashboard.example.com");
    expect(size).toBeGreaterThanOrEqual(21);
    expect((size - 17) % 4).toBe(0);
    // The three finder squares are dark in their corners.
    expect(d).toContain("M0 0h1v1h-1z");
    expect(d).toContain(`M${size - 1} 0h1v1h-1z`);
    expect(d).toContain(`M0 ${size - 1}h1v1h-1z`);
  });

  it("grows with longer text", () => {
    expect(qrPath("https://a.example").size).toBeLessThan(qrPath(`https://example.com/${"x".repeat(120)}`).size);
  });
});
