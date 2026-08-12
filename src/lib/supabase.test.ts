import { describe, expect, it, vi } from "vitest";

const getUserMock = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { getUser: getUserMock } })),
}));

describe("verifySupabaseToken", () => {
  it("returns the user's id and email for a valid token", async () => {
    getUserMock.mockResolvedValueOnce({
      data: { user: { id: "user-123", email: "owner@acme.com" } },
      error: null,
    });

    const { verifySupabaseToken } = await import("./supabase");
    const result = await verifySupabaseToken("valid-token");

    expect(result).toEqual({ id: "user-123", email: "owner@acme.com" });
  });

  it("returns null when Supabase reports an error", async () => {
    getUserMock.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "invalid JWT" },
    });

    const { verifySupabaseToken } = await import("./supabase");
    expect(await verifySupabaseToken("bad-token")).toBeNull();
  });

  it("returns null if the underlying call throws", async () => {
    getUserMock.mockRejectedValueOnce(new Error("network error"));

    const { verifySupabaseToken } = await import("./supabase");
    expect(await verifySupabaseToken("whatever")).toBeNull();
  });
});
