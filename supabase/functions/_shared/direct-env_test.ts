import { assertEquals } from "jsr:@std/assert@1";
import { directNetwork, isLocalStack } from "./direct-env.ts";

Deno.test("network: bitcoin unless a known network is named", () => {
  assertEquals(directNetwork(undefined), "bitcoin");
  assertEquals(directNetwork("regtest"), "regtest");
  assertEquals(directNetwork(" signet "), "signet");
  assertEquals(directNetwork("liquid"), "bitcoin");
});

Deno.test("test hooks only on a loopback SUPABASE_URL", () => {
  assertEquals(isLocalStack("http://127.0.0.1:54321"), true);
  assertEquals(isLocalStack("http://localhost:54321"), true);
  for (const u of ["https://riumaeihemgznvgattoc.supabase.co", "http://127.0.0.1.evil.example.com", "https://127.0.0.1:54321", "http://localhost.example.com"]) {
    assertEquals(isLocalStack(u), false, u);
  }
});
