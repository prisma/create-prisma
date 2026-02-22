# Changesets

This folder tracks release notes and version bumps for `create-prisma`.

## Usage

1. Create a changeset in your branch:
   - `bun run changeset`
2. Commit the generated markdown file.
3. After merge to `main`, the Changesets GitHub Action opens or updates a release PR.
4. Merging that PR updates `CHANGELOG.md` and package versions.
