import { coarseGeo } from "./geo.ts";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

Deno.test("coarse geo keeps country, region and city only, cleaned", () => {
  eq(coarseGeo(new Headers({ "cf-ipcountry": "bd", "cf-region": " Dhaka   Division ", "cf-ipcity": "Dhaka", "cf-connecting-ip": "203.0.113.9" })),
    { country: "BD", region: "Dhaka Division", city: "Dhaka" }, "full");
  eq(coarseGeo(new Headers({ "cf-ipcountry": "XX" })), { country: null, region: null, city: null }, "unknown");
  eq(coarseGeo(new Headers({ "cf-ipcountry": "T1" })).country, null, "tor");
  eq(coarseGeo(new Headers({ "cf-ipcountry": "Bangladesh" })).country, null, "not a code");
  eq(coarseGeo(new Headers({ "cf-ipcity": "x".repeat(200) })).city?.length, 80, "capped");
  eq(coarseGeo(new Headers()), { country: null, region: null, city: null }, "none");
});
