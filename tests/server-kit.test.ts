/** deploy/server: the self-host kit. Scripts parse, units hold their limits, nothing touches the system, CI state is read right. */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ciState } from "../deploy/server/ci-status.ts";

const dir = fileURLToPath(new URL("../deploy/server/", import.meta.url));
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const bash = spawnSync("bash", ["--version"]).status === 0;
const scripts = ["install.sh", "update.sh", "backup.sh"];

describe("the shell scripts", () => {
  test.skipIf(!bash).each(scripts)("%s parses (bash -n) and stops on errors", (f) => {
    const res = spawnSync("bash", ["-n", join(dir, f)], { encoding: "utf8" });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(read(f)).toMatch(/^#!\/usr\/bin\/env bash\n/);
    expect(read(f)).toMatch(/^set -euo pipefail$/m);
  });

  test("nothing in the kit uses sudo, writes outside the home directory, or touches other units or cloudflared configs", () => {
    for (const f of readdirSync(dir)) {
      const text = read(f);
      const code = text
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("#"))
        .join("\n");
      expect(code, f).not.toMatch(/\bsudo\b/);
      expect(code, f).not.toMatch(/\/etc\/(systemd|cloudflared)/);
      expect(code, f).not.toMatch(
        /systemctl\s+(?!--user)(start|stop|enable|disable|restart|daemon-reload|status|is-active)/,
      );
      expect(code, f).not.toMatch(/\brm -rf? \/(?!\S*tmp)/);
    }
  });

  test("install.sh verifies the Node tarball against SHASUMS256.txt, pins Node 24 on linux-x64 and refuses root", () => {
    const text = read("install.sh");
    expect(text).toMatch(/NODE_VERSION="24\.\d+\.\d+"/);
    expect(text).toContain("SHASUMS256.txt");
    expect(text).toContain("sha256sum -c");
    expect(text).toContain("linux-x64");
    expect(text).toContain("https://nodejs.org/dist/");
    expect(text).toMatch(/id -u/);
  });

  test("update.sh locks, checks CI, smoke-tests on a spare port, switches atomically, rolls back and keeps three releases", () => {
    const text = read("update.sh");
    expect(text).toContain("flock -n");
    expect(text).toContain("check-runs");
    expect(text).toContain("ci-status.ts");
    expect(text).toContain("/healthz");
    expect(text).toContain("/showcase");
    expect(text).toContain("mv -T");
    expect(text).toMatch(/rollback/i);
    expect(text).toMatch(/tail -n \+4/);
    expect(text).toContain("x-ratelimit-remaining");
  });
});

describe("the units", () => {
  test("ibow.service runs the pinned Node from current, with limits and hardening, as a user unit", () => {
    const text = read("ibow.service");
    expect(text).toContain("ExecStart=%h/apps/ibow/node/bin/node");
    expect(text).toContain("WorkingDirectory=%h/apps/ibow/current");
    expect(text).toContain("EnvironmentFile=%h/apps/ibow/ibow.env");
    expect(text).toContain("Restart=on-failure");
    expect(text).toContain("MemoryMax=300M");
    expect(text).toContain("CPUQuota=50%");
    expect(text).toContain("NoNewPrivileges=true");
    expect(text).toContain("WantedBy=default.target");
    expect(text).not.toMatch(/^User=/m);
  });

  test("the update and backup timers are randomised and pair with oneshot services", () => {
    expect(read("ibow-update.timer")).toMatch(/OnUnitInactiveSec=5min/);
    expect(read("ibow-update.timer")).toMatch(/RandomizedDelaySec=/);
    expect(read("ibow-update.service")).toContain("Type=oneshot");
    expect(read("ibow-backup.timer")).toMatch(/OnCalendar=/);
    expect(read("ibow-backup.service")).toContain("ExecStart=%h/apps/ibow/bin/backup.sh");
    for (const t of ["ibow-update.timer", "ibow-backup.timer"]) expect(read(t)).toContain("WantedBy=timers.target");
  });

  test("the tunnel unit runs cloudflared with the user's own config, and the example ends in a 404", () => {
    expect(read("cloudflared-ibow.service")).toContain("tunnel run");
    expect(read("cloudflared-ibow.service")).toContain("%h/.cloudflared/ibow.yml");
    const yml = read("cloudflared-ibow.yml.example");
    expect(yml).toContain("service: http://127.0.0.1:8790");
    expect(yml.trimEnd().split("\n").pop()).toContain("service: http_status:404");
  });

  test("the env example sets the loopback port the tunnel and the health checks use, and trusts the one proxy", () => {
    const env = read("ibow.env.example");
    expect(env).toMatch(/^HOST=127\.0\.0\.1$/m);
    expect(env).toMatch(/^PORT=8790$/m);
    expect(env).toMatch(/^TRUST_PROXY=1$/m);
  });

  test("every file the install script copies exists", () => {
    const text = read("install.sh");
    for (const m of text.matchAll(
      /\b((?:ibow|cloudflared-ibow)[\w.-]*\.(?:service|timer|example)|update\.sh|backup\.sh|ci-status\.ts)\b/g,
    )) {
      expect(existsSync(join(dir, m[1] as string)), m[1]).toBe(true);
    }
  });
});

describe("ciState: a release is built only when CI concluded success", () => {
  const run = (status: string, conclusion: string | null) => ({ status, conclusion });
  test("no runs yet is none; any unfinished run is pending", () => {
    expect(ciState({ total_count: 0, check_runs: [] })).toBe("none");
    expect(ciState({ check_runs: [run("completed", "success"), run("in_progress", null)] })).toBe("pending");
    expect(ciState({ check_runs: [run("queued", null)] })).toBe("pending");
  });
  test("all completed and successful is success; skipped and neutral do not block", () => {
    expect(ciState({ check_runs: [run("completed", "success")] })).toBe("success");
    expect(
      ciState({ check_runs: [run("completed", "success"), run("completed", "skipped"), run("completed", "neutral")] }),
    ).toBe("success");
  });
  test("a failed, cancelled or timed-out run is a failure, even while others are pending", () => {
    for (const c of ["failure", "cancelled", "timed_out", "action_required", "startup_failure"]) {
      expect(ciState({ check_runs: [run("completed", c)] }), c).toBe("failure");
    }
    expect(ciState({ check_runs: [run("completed", "failure"), run("in_progress", null)] })).toBe("failure");
  });
  test("anything that is not a check-runs reply is refused, never read as success", () => {
    for (const bad of [null, {}, "x", { check_runs: "no" }, { message: "API rate limit exceeded" }]) {
      expect(() => ciState(bad)).toThrow("check-runs");
    }
  });
});
