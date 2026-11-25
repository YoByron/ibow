import { describe, expect, test } from "vitest";
import { sharedTags } from "../src/client/catalog.ts";

describe("a section's shared tags", () => {
  test("a tag on every item of a section is shared, in any case; one item alone shares nothing", () => {
    expect([
      ...sharedTags([{ tags: ["Vegan", "Organic"] }, { tags: ["vegan"] }, { tags: ["VEGAN", "Spicy"] }]),
    ]).toEqual(["vegan"]);
    expect(sharedTags([{ tags: ["Vegan"] }, {}]).size).toBe(0);
    expect(sharedTags([{ tags: ["Vegan"] }]).size).toBe(0);
  });
});
