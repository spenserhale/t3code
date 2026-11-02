import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { resolveNewProjectsRoot } from "./newProjectsDirectory.ts";

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
