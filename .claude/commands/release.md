Create a new release for Stuductor/Coppice.

## Steps

1. **Determine the new version.** Run `git tag --sort=-v:refname | head -5` to see recent tags, and read the current version from `package.json`. If "$ARGUMENTS" is provided, use that as the new version (strip any leading "v"). Otherwise, ask the user what version to release.

2. **Check prerequisites:**
   - Run `git status` to ensure the working tree is clean (no uncommitted changes). If dirty, stop and tell the user to commit or stash first.
   - Run `git log --oneline $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD` to show what commits will be in this release. Present these to the user for confirmation before proceeding.

3. **Bump the version** in all three files (use the exact version number without "v" prefix):
   - `package.json` — the `"version"` field
   - `src-tauri/tauri.conf.json` — the `"version"` field
   - `src-tauri/Cargo.toml` — the `version` field

4. **Update the Cargo lock file** by running `cd src-tauri && cargo generate-lockfile`.

5. **Commit the version bump:**
   ```
   git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
   git commit -m "Release v<VERSION>"
   ```

6. **Tag and push:**
   ```
   git tag v<VERSION>
   git push origin main
   git push origin v<VERSION>
   ```

7. Tell the user the release is underway and that the `Build & Release` GitHub Actions workflow will create the GitHub Release with binaries once CI completes.
