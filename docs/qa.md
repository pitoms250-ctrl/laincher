# Design QA

## Play

Screenshots:

- [960 x 600](screenshots/play-960x600.png)
- [1200 x 720](screenshots/play-1200x720.png)
- 1600 x 900 was attempted, but the current display is 1366 x 768 and Windows constrained the actual window to 1600 x 780. The resulting image is retained as `screenshots/play-1600x900-attempt.png`; it is not a valid 1600 x 900 viewport check.

Results:

- The hero, play button, version selector, news, servers, and Java controls remain visible at both supported capture sizes. At 960 x 600 the page scrolls vertically; the window itself has no horizontal scroll.
- The play button label is not clipped. The old 1040 x 660 minimum was reduced to 960 x 600.
- The empty news/server states are visible when their bound collections are empty and expose the existing refresh command.
- Supplied island, village, and laptop decorations render with explicit decode sizes and do not cover text or controls in the two inspected viewports.
- Palette contrast calculations are recorded in `design-audit.md`; primary and secondary text thresholds pass on Bg0/Bg2.
- Build: `dotnet build src/Launcher.UI/Launcher.UI.csproj --no-restore --configuration PlayCheck` passed.
- Not manually verified yet: keyboard Tab/Shift+Tab/Enter/Esc order, high-DPI scaling, the 1600 x 900 viewport, delayed loading/error states, reduced-motion behavior, and idle CPU.

## Versions

Screenshots:

- [960 x 600](screenshots/versions-960x600.png)
- [1200 x 720](screenshots/versions-1200x720.png)

Results:

- Search, supported Release/Snapshot/Beta+Alpha controls, selected-version action, and version rows fit without clipping at both captured sizes.
- Rows retain `PickVersionCommand`; filtering retains the existing `ShowSnapshots`, `ShowOld`, and `VersionSearch` bindings.
- The empty collection state is implemented in XAML. A distinct manifest loading/error/retry state is not available from the current view model without logic changes.
- Build: `dotnet build src/Launcher.UI/Launcher.UI.csproj --no-restore --configuration VersionsCheck` passed. Four existing DPAPI platform warnings remain.
- Not manually verified yet: keyboard traversal, high-DPI scaling, 1600 x 900, and manifest failure/retry behavior.

## News

Screenshots:

- [960 x 600](screenshots/news-960x600.png)
- [1200 x 720](screenshots/news-1200x720.png)

Results:

- The empty feed state and existing refresh command render without overlap. Crystals stay within the header region.
- The runtime returned an empty news collection during capture, so article cover rendering, 16:9 crop, and hover zoom are implemented but not visually verified against a loaded article.
- Build: `dotnet build src/Launcher.UI/Launcher.UI.csproj --no-restore --configuration NewsCheck` passed. Four existing DPAPI platform warnings remain.

## Online

Screenshots:

- [960 x 600](screenshots/online-960x600.png)
- [1200 x 720](screenshots/online-1200x720.png)

Results:

- Address entry, add/refresh actions, empty state, and village art fit both captures.
- Runtime returned no servers during capture. Server card, icon URL, player count, ping, and connection-button layout need visual confirmation with a populated server collection.
- Build: `dotnet build src/Launcher.UI/Launcher.UI.csproj --no-restore --configuration OnlineCheck` passed. Four existing DPAPI platform warnings remain.
- Search and remove actions are not present in the existing view model; no nonfunctional controls were added.

## Skins

Screenshots:

- [960 x 600](screenshots/skins-960x600.png)
- [1200 x 720](screenshots/skins-1200x720.png)

Results:

- Pixel-art canvas uses `NearestNeighbor`; both the 64x64 canvas and model preview render at each captured size.
- The tool rail remains visible. The right editor panel scrolls at 960 x 600 so palette, HEX, nickname, and export controls remain reachable.
- Fox decoration stays in the header and does not cover controls.
- Build: `dotnet build src/Launcher.UI/Launcher.UI.csproj --no-restore --configuration SkinsCheck` passed. Four existing DPAPI platform warnings remain.
- Not manually verified yet: mouse paint/undo interactions, keyboard focus order, high-DPI scaling, and 1600 x 900.

## Mods

Screenshots:

- [960 x 600](screenshots/mods-960x600.png)
- [1200 x 720](screenshots/mods-1200x720.png)

Results:

- Search, loader/sort filters, version toggle, JAR add, folder/open/refresh, installed-file delete, and the chest decoration fit at both sizes.
- The Modrinth request was still in progress during capture. Result-card icon/description layouts are compiled but not visually verified with returned results.
- The existing view model provides no enabled/disabled property or drag/drop import handler. These features were intentionally not simulated in XAML.
- Build: `dotnet build src/Launcher.UI/Launcher.UI.csproj --no-restore --configuration ModsCheck` passed. Four existing DPAPI platform warnings remain.
- Not manually verified yet: drag/drop, mod toggling, focus traversal, high-DPI scaling, and 1600 x 900.

## Settings

Screenshots:

- [960 x 600](screenshots/settings-960x600.png)
- [1200 x 720](screenshots/settings-1200x720.png)

Results:

- Storage, memory, launch and about sections use the existing commands/bindings. At 960 x 600, remaining controls are reachable by vertical scrolling.
- JVM arguments use a monospaced multiline input. The supplied tools asset stays in the header area.
- XMX remains bound to existing `XmxMb` with the existing 1,024–16,384 MiB limits. The machine has about 12,203 MiB physical RAM and the saved setting is 9,728 MiB; no hardware-specific maximum or VM logic was added.
- Build: `dotnet build src/Launcher.UI/Launcher.UI.csproj --no-restore --configuration SettingsCheck` passed. Four existing DPAPI platform warnings remain.
- Not manually verified yet: slider behavior with extreme JVM args, high-DPI scaling, keyboard traversal, and 1600 x 900.

## Assets and motion

- All eight supplied PNGs are present as WPF resources. The reviewed screens use island/village/laptop, tools/empty-box, crystals, village, fox, chest/empty-box, and tools assets as specified.
- Decorative motion is limited to transforms/opacity/shadow radius and uses `IsVisible` enter/exit storyboard triggers. Static screenshots confirm asset placement; 60 fps, idle CPU, and disabled-system-animation behavior were not measured.

## Global shell

- Sidebar width is tokenized to 232 px; active, hover, pressed, disabled, and focus states are defined in XAML. Existing WindowChrome, caption buttons, and drag handlers are retained.
- Footer progress now uses the themed ProgressBar track. Network/error log details remain in the existing footer; a toast with details/retry cannot be wired without additional view-model commands.
- Final post-fix runtime launch succeeded and the shell was captured at [1200 x 720](screenshots/final-shell-1200x720.png). Earlier Windows crash events were traced to `Double` resources used as `GridLength` and string `Command` values in the ProgressBar; both have been corrected.
- Full 1600 x 900 and high-DPI/keyboard/reduced-motion/idle-CPU validation remain unavailable or unverified on the current 1366 x 768 desktop.