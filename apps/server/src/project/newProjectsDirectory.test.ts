import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { defaultNewProjectsRoot, resolveNewProjectsRoot } from "./newProjectsDirectory.ts";

it.effect("names the folder new projects go in, or falls back to the default", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = path.resolve("home", "spenser");
    const defaultRoot = path.resolve("data", "projects");
    const root = (setting: string) => resolveNewProjectsRoot(setting, defaultRoot, path, home);
    const elsewhere = path.resolve("srv", "projects");

    assert.equal(root(""), defaultRoot);
    assert.equal(root("~"), home);
    assert.equal(root("~/Code/new"), path.join(home, "Code", "new"));
    assert.equal(root(elsewhere), elsewhere);
    assert.equal(root(`${elsewhere}${path.sep}`), elsewhere);
    assert.equal(root(`${elsewhere}${path.sep}..${path.sep}other`), path.resolve("srv", "other"));
    // A relative path has no anchor on the server, so clients are told the default instead.
    assert.equal(root("projects"), defaultRoot);
    assert.equal(root("./projects"), defaultRoot);
    assert.equal(root("~other/projects"), defaultRoot);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "defaults to the T3 home's projects folder, or a branded one only under the standard home",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = path.resolve("home", "spenser");
      const standard = path.join(home, ".t3");
      const sandbox = path.resolve("worktree", ".t3");
      const branded = "~/.se/projects";
      const root = (baseDir: string, brandedRoot: string | null) =>
        defaultNewProjectsRoot(baseDir, path, home, brandedRoot);

      assert.equal(root(standard, null), path.join(standard, "projects"));
      assert.equal(root(standard, branded), path.join(home, ".se", "projects"));
      assert.equal(root(`${standard}${path.sep}`, branded), path.join(home, ".se", "projects"));
      // A dev worktree or an explicit T3CODE_HOME is a sandbox, so it must not reach the real home.
      assert.equal(root(sandbox, branded), path.join(sandbox, "projects"));
      assert.equal(root(standard, "se/projects"), path.join(standard, "projects"));
    }).pipe(Effect.provide(NodeServices.layer)),
);
