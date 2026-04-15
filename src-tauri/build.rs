fn main() {
    // TODO(windows): embed an application manifest with
    //   <ws2:longPathAware>true</ws2:longPathAware>
    // so worktree paths > 260 chars work on Windows 10 1607+. The catch is
    // that tauri-build already embeds a default manifest, so adding a second
    // one via embed-resource/winres conflicts. Requires coordinating with
    // tauri-build's manifest override hook (not yet stable in Tauri 2).
    tauri_build::build()
}
