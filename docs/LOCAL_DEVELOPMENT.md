# Local development & install

How to build the monorepo and install it into a throwaway project **without publishing to npm** —
the loop for developing the scaffolder and plugins. Everything here uses local tarballs (`npm pack`),
so nothing touches the registry.

- [1. Build the toolchain](#1-build-the-toolchain)
- [2. Scaffold a core project](#2-scaffold-a-core-project)
- [3. Add a plugin locally](#3-add-a-plugin-locally)
- [4. Iterating (edit → rebuild → reinstall)](#4-iterating-edit--rebuild--reinstall)
- [5. Optional: a global `create-pwtap`](#5-optional-a-global-create-pwtap)
- [6. Smoke test](#6-smoke-test)
- [Notes](#notes)

> Prerequisite: **Node.js ≥ 20.19**. Replace `<repo>` below with this repository's absolute path
> (e.g. `/Users/you/Automation_Projects/test-automation-platform`).

## 1. Build the toolchain

From the monorepo root, once (and after pulling changes):

```bash
npm install                              # install workspaces (single lockfile)
npm run build                            # tsc -b — builds platform → create → plugins
npm run bundle:template -w @pwtap/create # copy core-template/files into create/template
```

`bundle:template` is what `create` ships as the copied-in core. `npm pack -w @pwtap/create` also runs
it automatically (via `prepack`), but running it now lets you scaffold straight from `dist/`.

## 2. Scaffold a core project

Run the built CLI directly (no install needed):

```bash
node <repo>/packages/create/dist/index.js ~/pwtap-demo        # interactive menu
node <repo>/packages/create/dist/index.js ~/pwtap-demo -y     # accept defaults, no prompts
```

Useful flags: `--no-browsers` (skip the Chromium download — fast), `--no-install` (skip `npm install`),
`--tests-dir <name>` (rename the tests folder), `--gha` (add a GitHub Actions workflow), `--ai-judge`
/ `--maestro` (preselect a plugin). Then:

```bash
cd ~/pwtap-demo
cp env/environments.example.json env/environments.json
npm test                                  # chromium + api
```

## 3. Add a plugin locally

Plugins aren't installed from npm here — you pack a tarball from the monorepo and install it.

> **Where to run `add` / `remove`:** from **inside the scaffolded project** (e.g. `~/pwtap-demo`),
> _not_ the monorepo. They operate on the current directory (`process.cwd()`); the
> `node <repo>/packages/create/dist/index.js` prefix is only the path to the CLI file — what it wires
> up is wherever you `cd`'d to. (With a global `create-pwtap`, see §5, it's just `create-pwtap add …`.)

**AI Judge** (no other `@pwtap` deps):

```bash
# in the monorepo:
npm pack -w @pwtap/plugin-ai-judge --pack-destination ~        # → ~/pwtap-plugin-ai-judge-<v>.tgz

# in the scaffolded project:
cd ~/pwtap-demo
npm install -D ~/pwtap-plugin-ai-judge-*.tgz
node <repo>/packages/create/dist/index.js add ai-judge --no-install
```

**Maestro** (depends on `@pwtap/platform`):

```bash
# in the monorepo:
npm pack -w @pwtap/plugin-maestro --pack-destination ~         # → ~/pwtap-plugin-maestro-<v>.tgz

cd ~/pwtap-demo
npm install -D ~/pwtap-plugin-maestro-*.tgz                    # resolves @pwtap/platform from npm
node <repo>/packages/create/dist/index.js add maestro --no-install
```

`--no-install` tells `add` **not** to `npm install` the plugin from the registry — you already
installed the tarball. `add` then loads the plugin's manifest and wires it in (fixtures barrel, env
keys, an env-gated Playwright project, example specs, docs, scripts).

> **Fully-local `@pwtap/platform`.** The Maestro tarball declares `@pwtap/platform: ^0.1.0`, so npm
> pulls the **published** platform. To test **local** platform changes too, pack and install it first:
>
> ```bash
> npm pack -w @pwtap/platform --pack-destination ~
> cd ~/pwtap-demo && npm install -D ~/pwtap-platform-*.tgz ~/pwtap-plugin-maestro-*.tgz
> ```

## 4. Iterating (edit → rebuild → reinstall)

After changing a plugin's source:

```bash
# in the monorepo:
npm run build
npm pack -w @pwtap/plugin-maestro --pack-destination ~

# in the project:
cd ~/pwtap-demo
npm install -D ~/pwtap-plugin-maestro-*.tgz
node <repo>/packages/create/dist/index.js add maestro --no-install   # re-wire (idempotent)
```

`add` is idempotent — re-running it won't duplicate the barrel/config/env entries. To remove a plugin:
`node <repo>/packages/create/dist/index.js remove maestro`.

## 5. Optional: a global `create-pwtap`

For a nicer loop, install the `create` tarball globally so the `create-pwtap` command is on your PATH:

```bash
npm pack -w @pwtap/create --pack-destination ~     # prepack bundles the template
npm install -g ~/pwtap-create-*.tgz

create-pwtap ~/pwtap-demo -y                       # scaffold
cd ~/pwtap-demo && create-pwtap add maestro        # from inside the project
```

> `npm init @pwtap` / `npm create @pwtap` only work once `@pwtap/create` is **published** — they
> resolve the initializer from the registry, not a global install. Locally, use `create-pwtap` (above)
> or the `node <repo>/packages/create/dist/index.js` form.

## 6. Smoke test

The repo's end-to-end check scaffolds a core-only project into a temp dir and verifies it builds and
runs:

```bash
npm run smoke
```

## Notes

- **Tarball, not `npm link`.** Packing mirrors exactly what gets published (respecting the `files`
  allow-list and `prepack`), so it catches missing-file bugs that `npm link` hides.
- **The version in the tarball name** (`-0.1.0.tgz`) is the package's current version; the `*` glob in
  the commands above matches whatever it is.
- **Live plugin runs need their tools.** AI Judge needs a reachable model (`JUDGE_MODEL` + key);
  Maestro needs the Maestro CLI + a JDK 17+ and a device. Without them the example specs skip, not fail.
