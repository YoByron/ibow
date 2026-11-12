/** M7 review: the analyst panel marks exactly the numbers the check couldn't back. */

import { describe, expect, test } from "vitest";
import { markUnbacked } from "../src/client/owner-ai-view.ts";

describe("marking unbacked numbers", () => {
  test("splits the answer so each unbacked number stands alone, and nothing else is marked", () => {
    expect(markUnbacked("You had 99 orders in 3 hours [today.orders].", ["99", "3"])).toEqual([
      { text: "You had ", unbacked: false },
      { text: "99", unbacked: true },
      { text: " orders in ", unbacked: false },
      { text: "3", unbacked: true },
      { text: " hours [today.orders].", unbacked: false },
    ]);
  });

  test("a number is marked only where it stands alone, not inside a longer one", () => {
    expect(markUnbacked("On 2026-11-03, 3 more [x].", ["3"])).toEqual([
      { text: "On 2026-11-03, ", unbacked: false },
      { text: "3", unbacked: true },
      { text: " more [x].", unbacked: false },
    ]);
  });

  test("citations of unknown keys and spoken times are marked too; nothing unbacked leaves the text whole", () => {
    expect(markUnbacked("At 7 PM [made.up].", ["7 PM", "[made.up]"]).filter((s) => s.unbacked)).toEqual([
      { text: "7 PM", unbacked: true },
      { text: "[made.up]", unbacked: true },
    ]);
    expect(markUnbacked("Fine [today.orders].", [])).toEqual([{ text: "Fine [today.orders].", unbacked: false }]);
  });
});
