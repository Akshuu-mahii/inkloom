/**
 * Which databases may be reached without TLS.
 *
 * This decides whether credentials cross a network in clear text, so the two
 * directions are not equally bad. Treating a managed database as private would
 * send a password unencrypted over the internet. Treating a container on the
 * loopback as public only fails a connection that was never encrypted anyway.
 *
 * It also has to include private ranges rather than loopback alone, because a
 * Worker in local development cannot open a connection to loopback at all:
 * miniflare runs it behind a network policy that permits `public` and `private`
 * and not `local`. CI therefore points the Worker at the runner's own private
 * address, and that address needs the same answer as 127.0.0.1.
 */
import { describe, expect, it } from "vitest";
import { isPrivateAddress } from "../../../workers/app";

const url = (host: string) => `postgres://user:pass@${host}:5432/inkloom`;

describe("addresses that need no TLS", () => {
  it.each([
    ["loopback", "127.0.0.1"],
    ["another loopback address", "127.0.0.53"],
    ["localhost", "localhost"],
    ["IPv6 loopback", "[::1]"],
    ["a 10/8 address", "10.1.0.42"],
    ["a 172.16/12 address", "172.17.0.2"],
    ["the top of 172.16/12", "172.31.255.254"],
    ["a 192.168/16 address", "192.168.1.10"],
    ["a link-local address", "169.254.10.1"],
  ])("%s", (_label, host) => {
    expect(isPrivateAddress(url(host))).toBe(true);
  });
});

describe("addresses that must keep TLS", () => {
  it.each([
    ["a Neon host", "ep-cool-name-123.ap-southeast-1.aws.neon.tech"],
    ["any public hostname", "db.example.com"],
    ["a public IP", "203.0.113.10"],
    // 172.15 and 172.32 sit OUTSIDE 172.16/12 — the boundary an off-by-one
    // here would quietly send credentials in clear text.
    ["just below the 172.16/12 range", "172.15.0.1"],
    ["just above the 172.16/12 range", "172.32.0.1"],
    ["a host that merely contains a private address", "127.0.0.1.attacker.example"],
    ["a host that merely mentions localhost", "localhost.attacker.example"],
  ])("%s", (_label, host) => {
    expect(isPrivateAddress(url(host))).toBe(false);
  });

  it("keeps TLS when the connection string cannot be parsed", () => {
    expect(isPrivateAddress("not a url")).toBe(false);
    expect(isPrivateAddress("")).toBe(false);
  });
});
