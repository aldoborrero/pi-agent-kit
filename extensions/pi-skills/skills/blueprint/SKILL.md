---
name: blueprint
description: >
  Expert guidance for numtide/blueprint — an opinionated Nix flake library that maps a
  standard folder structure to flake outputs. Use this skill whenever the user asks about
  blueprint in any Nix context: setting up a new project with blueprint, understanding the
  folder structure (packages/, devshells/, hosts/, modules/, checks/, lib/, templates/),
  writing or debugging package.nix / devshell.nix / configuration.nix files under blueprint
  conventions, configuring the flake.nix invocation (prefix, systems, nixpkgsConfig,
  overlays), migrating an existing flake to blueprint, or combining blueprint with other
  numtide tools (devshell, treefmt, flake-utils, system-manager). Also trigger for questions
  about per-system function arguments (inputs, flake, pkgs, perSystem, system) and the
  automatic checks/outputs blueprint wires up.
---

# numtide/blueprint Skill

Blueprint is a **zero-module-system flake structuring library** from Numtide. Instead of a
module system, it uses a predictable 1:1 mapping between files/folders and flake outputs.

Docs: https://numtide.github.io/blueprint/main/
Source: https://github.com/numtide/blueprint

---

## Core philosophy

- **KISS** — no infinite recursion, no module system magic.
- **1:1 mapping** — each file maps to exactly one flake output.
- **User workflows first** — easy to start, easy to escape when complexity grows.
- Not a replacement for flake-parts; it's intentionally more restrictive and simpler.

---

## Minimal flake.nix

```nix
{
  inputs = {
    blueprint.url = "github:numtide/blueprint";
    nixpkgs.url   = "github:nixos/nixpkgs/nixos-unstable";
  };
  outputs = inputs: inputs.blueprint { inherit inputs; };
}
```

Bootstrap with: `nix flake init -t github:numtide/blueprint`

---

## Configuration options (passed to `inputs.blueprint { }`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `inputs` | attrset | required | The flake inputs attrset |
| `prefix` | string | `""` | Sub-directory holding the folder structure (e.g. `"nix/"`) |
| `systems` | list of strings | from `inputs.systems` → nix-systems/default | Target systems |
| `nixpkgsConfig` | attrset | `{}` | Merged into `nixpkgs.config` (e.g. `{ allowUnfree = true; }`) |
| `overlays` | list of functions | `[]` | nixpkgs overlays |

**Recommended:** use `prefix = "nix/";` to keep blueprint folders grouped.

```nix
outputs = inputs: inputs.blueprint {
  inherit inputs;
  prefix  = "nix/";
  systems = [ "x86_64-linux" "aarch64-linux" ];
};
```

---

## Folder structure overview

```
flake.nix              # minimal, rarely edited
[prefix/]
├── package.nix        # default package (maps to packages.default)
├── formatter.nix      # nix fmt target
├── devshell.nix       # default devshell (nix develop)
├── packages/
│   └── <pname>/
│       └── default.nix   # or <pname>.nix
├── devshells/
│   ├── <name>.nix
│   └── <name>.toml        # requires inputs.devshell
├── checks/
│   └── <name>.nix
├── hosts/
│   └── <hostname>/
│       ├── configuration.nix        # NixOS
│       ├── darwin-configuration.nix # nix-darwin
│       ├── system-configuration.nix # system-manager
│       ├── rpi-configuration.nix    # nixos-raspberrypi
│       ├── default.nix              # escape hatch
│       └── users/
│           ├── <username>.nix
│           └── <username>/home-configuration.nix
├── lib/
│   └── default.nix
├── modules/
│   ├── nixos/<name>.nix   → nixosModules.<name>
│   ├── darwin/<name>.nix  → darwinModules.<name>
│   └── home/<name>.nix    → homeModules.<name>
└── templates/
    └── <name>/
```

---

## Per-system file arguments

Files that are instantiated once per system receive:

| Arg | Description |
|-----|-------------|
| `inputs` | flake inputs attrset |
| `flake` | shorthand for `inputs.self` |
| `system` | current system string, e.g. `"x86_64-linux"` |
| `pkgs` | nixpkgs instance for this system |
| `perSystem` | packages of all inputs filtered by system — e.g. `perSystem.nixos-anywhere.default` |

---

## Packages

**Single default package** — `package.nix` at prefix root:
```nix
# package.nix
{ pkgs, ... }:
pkgs.buildGoModule { ... }
```

**Named packages** — `packages/<pname>/default.nix` or `packages/<pname>.nix`:
```nix
# packages/my-tool/default.nix
{ pkgs, perSystem, ... }:
pkgs.buildGoModule {
  pname = "my-tool";
  ...
}
```

Blueprint automatically adds `checks.<system>.pkgs-<pname>` for each package.

---

## Devshells

**Default devshell** — `devshell.nix`:
```nix
{ pkgs, perSystem, ... }:
pkgs.mkShell {
  packages = [ pkgs.go pkgs.gopls ];
}
```

**Multiple devshells** — `devshells/<name>.nix`:
```nix
# devshells/ci.nix
{ pkgs, ... }:
pkgs.mkShell { packages = [ pkgs.golangci-lint ]; }
```
Activate with `nix develop .#ci`.

Blueprint also adds `checks.<system>.devshell-<name>` for each devshell automatically.

---

## NixOS hosts

```nix
# hosts/myserver/configuration.nix
{ flake, inputs, perSystem, ... }:
{
  imports = [
    inputs.srvos.nixosModules.hardware-hetzner-cloud
    flake.nixosModules.my-service
  ];
  nixpkgs.hostPlatform = "x86_64-linux";
  system.stateVersion   = "24.11";
}
```

Outputs: `nixosConfigurations.myserver` + `checks.<s>.nixos-myserver`.

---

## Modules

```nix
# modules/nixos/my-service.nix
{ flake, inputs, perSystem }:  # outer function — blueprint calls this
{ pkgs, config, ... }:         # NixOS module
{
  config.services.my-service = {
    package = perSystem.self.my-tool;
  };
}
```

The outer function lets modules reference flake-local packages/inputs.
Outputs: `nixosModules.my-service`, `modules.nixos.my-service`.

---

## Home Manager users

```nix
# hosts/mypc/users/aldo/home-configuration.nix
{ flake, inputs, perSystem, ... }:
{
  imports = [ inputs.self.homeModules.shared ];
  home.stateVersion = "24.11";
}
```

Apply with `home-manager switch --flake .#aldo@mypc` or just `home-manager switch --flake .`
if username + hostname match.

---

## Automatic checks

Blueprint wires these checks with zero config:
- `checks.<s>.pkgs-<pname>` — per package
- `checks.<s>.pkgs-<pname>-<test>` — from `package.passthru.tests`
- `checks.<s>.devshell-<name>` — per devshell
- `checks.<s>.nixos-<hostname>` — system closure per NixOS host

Run all: `nix flake check`

---

## Common patterns

### Formatter (treefmt)
```nix
# formatter.nix
{ pkgs, ... }:
pkgs.writeShellApplication {
  name = "treefmt";
  ...
}
```
Or use `treefmt-nix` input.

### Lib
```nix
# lib/default.nix
{ flake, inputs }:
{
  myHelper = args: ...;
}
```
Available as `flake.lib.myHelper` in other files.

### Escape hatch (hosts/default.nix)
```nix
{ inputs, ... }: {
  class = "nixos";
  value = inputs.nixpkgs-unstable.lib.nixosSystem { ... };
}
```

---

## Integration with other Numtide tools

| Tool | Usage with blueprint |
|------|---------------------|
| `numtide/devshell` | `perSystem.devshell.mkShell` in devshell.nix; TOML devshells |
| `numtide/treefmt` | Use as formatter.nix package |
| `numtide/system-manager` | `hosts/<h>/system-configuration.nix` |
| `numtide/flake-utils` | Generally not needed; blueprint handles per-system |
| `nix-systems/default` | Default systems input consumed by blueprint |

---

## Quick migration checklist (from bare flake)

1. Add `blueprint` input, update `outputs = inputs: inputs.blueprint { inherit inputs; };`
2. Move `packages.<s>.default` derivation → `package.nix`
3. Move `devShells.<s>.default` → `devshell.nix`
4. Move named packages → `packages/<name>/default.nix`
5. Move NixOS hosts → `hosts/<hostname>/configuration.nix`
6. Move modules → `modules/nixos/`, `modules/home/`, etc.
7. Add `prefix = "nix/";` and reorganize into `nix/` if desired
8. Run `nix flake check` — blueprint auto-adds checks
