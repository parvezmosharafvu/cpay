import { assertEquals } from "jsr:@std/assert@1";
import { secretMatches } from "./secret-compare.ts";

Deno.test("secretMatches: only the exact secret matches; unset never does", () => {
  assertEquals(secretMatches("s3cret-value", "s3cret-value"), true);
  assertEquals(secretMatches("s3cret-valuf", "s3cret-value"), false);
  assertEquals(secretMatches("s3cret-value-longer", "s3cret-value"), false);
  assertEquals(secretMatches("s3cret", "s3cret-value"), false);
  assertEquals(secretMatches("", "s3cret-value"), false);
  assertEquals(secretMatches(null, "s3cret-value"), false);
  assertEquals(secretMatches("", ""), false);
  assertEquals(secretMatches(undefined, undefined), false);
  assertEquals(secretMatches("anything", ""), false);
});
