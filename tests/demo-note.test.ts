import { describe, expect, test } from "vitest";
import { type DemoInfo, demoNoteText } from "../src/client/demo-note.ts";

const info: DemoInfo = {
  demo: true,
  staff: [
    { id: "counter", pin: "1234", role: "counter" },
    { id: "station", pin: "5678", role: "station" },
  ],
  owner: { pin: "246810" },
};

describe("demo sign-in note", () => {
  test("names the counter and station IDs and PINs on the staff screen, and only the owner PIN on the owner's", () => {
    const staff = demoNoteText(info, "staff");
    expect(staff).toContain("Counter: ID counter, PIN 1234");
    expect(staff).toContain("Stations: ID station, PIN 5678");
    expect(staff).not.toContain("246810");
    const owner = demoNoteText(info, "owner");
    expect(owner).toContain("246810");
    expect(owner).not.toContain("1234");
  });
});
