# github-search

Search code across GitHub repositories using the GitHub API via the [GitHub CLI](https://cli.github.com/) (`gh search code`).

## Tool

**`github_search_code`** -- Search code across GitHub repositories.

## Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | `string` | Search query with GitHub search syntax (required) |
| `language` | `string` | Filter by programming language (e.g. `python`, `typescript`) |
| `owner` | `string` | Filter by repository owner (e.g. `nixos`, `microsoft`) |
| `repo` | `string` | Filter by specific repository (e.g. `nixos/nixpkgs`) |
| `extension` | `string` | Filter by file extension (e.g. `ts`, `nix`, `py`) |
| `filename` | `string` | Filter by filename (e.g. `flake.nix`, `Dockerfile`) |
| `limit` | `number` | Max results (default: 10, max: 100) |

## Examples

Search for `useState` in TypeScript files:
```json
{ "query": "useState", "language": "typescript" }
```

Find Nix flake configurations in a specific org:
```json
{ "query": "nixpkgs", "filename": "flake.nix", "owner": "nixos" }
```

## Use Cases

- Finding usage examples of APIs, libraries, or patterns
- Discovering how others implement specific functionality
- Finding configuration examples (Nix, Docker, CI/CD)
- Locating code in specific languages or repositories

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and in PATH
- Authenticated with GitHub (`gh auth login`)
