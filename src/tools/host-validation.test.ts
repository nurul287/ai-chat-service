import { describe, expect, it } from "vitest";
import { isAllowedEndpointUrl, isDisallowedHost } from "./host-validation";

describe("isDisallowedHost", () => {
  it.each([
    ["localhost", "the bare loopback name"],
    ["127.0.0.1", "IPv4 loopback"],
    ["127.1.2.3", "anywhere in 127.0.0.0/8"],
    ["0.0.0.0", "the unspecified address"],
    ["169.254.169.254", "the cloud metadata endpoint"],
    ["169.254.0.1", "IPv4 link-local"],
    ["10.0.0.1", "10.0.0.0/8"],
    ["10.255.255.255", "the top of 10.0.0.0/8"],
    ["172.16.0.1", "the bottom of 172.16.0.0/12"],
    ["172.31.255.254", "the top of 172.16.0.0/12"],
    ["192.168.1.1", "192.168.0.0/16"],
    ["postgres.railway.internal", "an .internal hostname"],
    ["postgres.railway.internal.", "an .internal hostname with a trailing dot"],
    ["PRINTER.LOCAL", "a .local hostname, case-insensitively"],
    ["app.localhost", "a .localhost subdomain"],
    ["[::1]", "IPv6 loopback"],
    ["[0:0:0:0:0:0:0:1]", "IPv6 loopback written out in full"],
    ["[::]", "the IPv6 unspecified address"],
    ["[fe80::1]", "IPv6 link-local"],
    ["[febf::abcd]", "the top of fe80::/10"],
    ["[fc00::1]", "IPv6 unique-local"],
    ["[fd12:3456::1]", "inside fc00::/7"],
    ["[::ffff:169.254.169.254]", "an IPv4-mapped metadata address"],
    ["", "an empty host"],
  ])("rejects %s (%s)", (hostname) => {
    expect(isDisallowedHost(hostname)).toBe(true);
  });

  it.each([
    ["tenant.example.com", "an ordinary public hostname"],
    ["api.tenant.example.com", "a public subdomain"],
    ["internal.example.com", "'internal' as a label, not the suffix"],
    ["localhost.example.com", "'localhost' as a label, not the whole host"],
    ["8.8.8.8", "a public IPv4"],
    ["100.20.30.40", "a public IPv4 that merely starts with 10"],
    ["11.0.0.1", "adjacent to but outside 10.0.0.0/8"],
    ["172.15.0.1", "just below 172.16.0.0/12"],
    ["172.32.0.1", "just above 172.16.0.0/12"],
    ["192.167.1.1", "just below 192.168.0.0/16"],
    ["192.169.1.1", "just above 192.168.0.0/16"],
    ["169.253.0.1", "just below 169.254.0.0/16"],
    ["[2606:4700:4700::1111]", "a public IPv6"],
  ])("allows %s (%s)", (hostname) => {
    expect(isDisallowedHost(hostname)).toBe(false);
  });
});

describe("isAllowedEndpointUrl", () => {
  it("requires https", () => {
    expect(isAllowedEndpointUrl("https://tenant.example.com/tool")).toBe(true);
    expect(isAllowedEndpointUrl("http://tenant.example.com/tool")).toBe(false);
    expect(isAllowedEndpointUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects an unparseable URL rather than throwing", () => {
    expect(isAllowedEndpointUrl("not-a-url")).toBe(false);
  });

  it("rejects an https URL on an internal host", () => {
    expect(isAllowedEndpointUrl("https://169.254.169.254/latest/meta-data/")).toBe(false);
  });
});
