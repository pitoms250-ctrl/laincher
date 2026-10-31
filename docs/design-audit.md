# F Launcher Design Audit

## Phase 0: Reconnaissance

Date: 2026-10-25

### Stack and startup

- Target framework: `net8.0-windows`; WPF enabled, with `net8.0` shared projects.
- MVVM: `CommunityToolkit.Mvvm` 8.3.2 (`ObservableObject`, source-generated observable properties and relay commands).
- No ModernWpf, MaterialDesign, HandyControl, or WPF-UI package is referenced by `Launcher.UI.csproj`.
- `App.xaml.cs` configures the host and assigns a singleton `MainViewModel` to `MainWindow`.
- `MainWindow.xaml` uses a borderless, transparent, resizable window with `WindowChrome`, custom caption buttons, and a code-behind drag/maximize handler.
- Current minimum window size is 1040 x 660, so the requested 960 x 600 viewport is not currently supported.

### Screen map

| Screen | XAML | ViewModel / binding context |
| --- | --- | --- |
| Play | `Views/PlayView.xaml` | `MainViewModel` |
| Versions | `Views/VersionsView.xaml` | `MainViewModel` |
| News | `Views/NewsView.xaml` | `MainViewModel` |
| Online | `Views/OnlineView.xaml` | `MainViewModel` |
| Skins | `Views/SkinsView.xaml` | `MainViewModel`, with nested `SkinEditorViewModel` |
| Mods | `Views/ModsView.xaml` | `MainViewModel` |
| Settings | `Views/SettingsView.xaml` | `MainViewModel` |
| Welcome dialog | `Views/WelcomeWindow.xaml` | No shared launcher VM is assigned in `App.xaml.cs` |
| Support dialog | `Views/SupportWindow.xaml` | Separate dialog |
| Game-folder dialog | `Views/PathDialog.xaml` | Separate dialog |

### Existing resources and duplication

- `App.xaml` merges only `Themes/GreenTheme.xaml`; there are no separate token dictionaries or control dictionaries yet.
- The theme combines color literals, brushes, typography-adjacent settings, and templates in one file. Screen XAML also repeats literal colors, font sizes, spacing, and dimensions.
- Button templates are split across `PlayButton`, `PillButton`, `OutlineButton`, and `IconButton`, with inconsistent focus/pressed states. Several local controls also set fixed heights.
- `Card`, navigation, input, ComboBox, CheckBox, Slider, and scrollbar styles exist, but many required states and components (empty/loading/error patterns, toast, skeleton, modal overlay) do not.
- `MainWindow.xaml` uses the unbundled font-family fallback `Inter, Montserrat, Segoe UI`; no font resources are currently included.
- `Launcher.UI.csproj` includes `Assets/*.jpg`, `Assets/*.png`, and `Assets/slides/*.jpg`. The eight supplied `imge/deco-*.png` assets are present in the source tree but are not included by the project file yet.

### Baseline and verification

- Baseline screenshot: [`screenshots/phase0-baseline.png`](screenshots/phase0-baseline.png).
- `dotnet build src/Launcher.UI/Launcher.UI.csproj --no-restore --configuration Release`: passed with SDK 10.0.401.
- Existing Release executable launched; window title was `F Launcher`, and the window responded to input.
- The screenshot shows the current Play screen at 1200 x 730. It confirms the current composition and data render, and visibly shows a crowded hero play button, fixed-width columns, and no supplied decorative assets.
- C: had approximately 0.27 GiB free at inspection. The attached Visual Studio CS8104 reports `IOException: Недостаточно места на диске` while writing `obj/Release/net8.0-windows/refint/FLauncher.dll`. The build succeeds now, so the error is not currently reproducible; low free space is consistent with the message but should not be treated as a proven sole cause.
- The configured default game/cache root is `%APPDATA%\\.fluncher`; the manifest is fetched as a string and written to `cache/version_manifest_v2.json` after creating the directory. The cache file was absent before the test run, then startup created it successfully (278,138 bytes) and the version list populated. No permission failure was observed. The same C: free-space constraint may explain the reported runtime write failure, but that failure is not reproducible with the current conditions and is not proven to be the sole cause.
- Installed physical memory: approximately 12,203 MiB. Saved `XmxMb`: 9,728 MiB (about 80% of physical memory). `SettingsView.xaml` currently allows up to 16,384 MiB, so the control's maximum exceeds installed RAM. No memory-allocation logic was changed.

### Reference review

- [Modrinth App](https://modrinth.com/app): reviewed current app and mod-management material; useful emphasis on content-first browsing and clear instance/mod actions.
- [Prism Launcher](https://prismlauncher.org): reviewed instance/mod management screenshots and lightweight customizable UI; useful dense information hierarchy and explicit actions.
- [Fluent 2](https://fluent2.microsoft.design): reviewed Windows component direction and accessibility resources; useful as a reference for consistent control states and focus order, not a direct style target.
- [WPF Animation Overview](https://learn.microsoft.com/dotnet/desktop/wpf/graphics-multimedia/animation-overview): confirms storyboard-based property animation patterns.
- [WPF 2D and Imaging Performance](https://learn.microsoft.com/dotnet/desktop/wpf/advanced/optimizing-performance-2d-graphics-and-imaging): advises decoding images to intended display size and notes bitmap scaling quality can impact animated-image frame rate.

### Phase 0 issues to address in later phases

1. Split the monolithic theme into explicit tokens and reusable control dictionaries. (Token dictionaries completed in Phase 1; reusable controls remain for Phase 2.)
2. Bundle and verify a Russian-capable font before choosing final typography. (Completed in Phase 1.)
3. Include the supplied decorative PNG resources in the WPF project. (Completed in Phase 1.)
4. Replace fixed-height text buttons and test the specified minimum viewport after a proposed minimum-size adjustment.
5. Add consistent keyboard-focus, pressed, disabled, loading, error, and empty states.
6. Rework screen layouts and validate each screen at the three requested sizes.
7. Investigate the manifest write failure separately; do not change its service logic without explicit approval.

## Phase 1: Design tokens and resources

- Added dedicated `Colors.xaml`, `Typography.xaml`, `Metrics.xaml`, `Effects.xaml`, and `Animations.xaml` dictionaries and merged them through `App.xaml`.
- Selected Manrope for interface text, Onest for display headings, and JetBrains Mono for technical values. Bundled static regular/semibold/bold faces as WPF resources so they do not depend on installed fonts. Each font is SIL OFL 1.1; the corresponding license files are included in `Fonts/` and copied to output.
- Verified the Russian sample `Версия и Java · Папка игры` against every bundled font face using FontTools. The selected families' Google Fonts specimens also render the Cyrillic sample.
- Added the eight supplied `imge/*.png` files as WPF resources. Screen placement and image decode sizes remain for the relevant screen phases.
- Added shared float, rotate, and glow storyboards for supplied decorative images. They start only while the image is visible and stop when hidden; the Play laptop uses the slow ±2° rotation.
- Updated the window to use the bundled body font, text color token, Display formatting, and ClearType rendering.
- WCAG contrast calculation for the supplied palette: TextPrimary on Bg0 18.68:1 and Bg2 16.31:1; TextSecondary 10.50:1 and 9.17:1; TextTertiary 5.19:1 and 4.53:1. Accent400 11.29:1 and 9.86:1. The requested primary and secondary contrast thresholds pass on both backgrounds.
- `dotnet build src/Launcher.UI/Launcher.UI.csproj --no-restore --configuration Release`: passed. Launch smoke test succeeded and the Play screen was captured at 1200 x 730: [`screenshots/phase1-tokens.png`](screenshots/phase1-tokens.png).
- No controls or screen layouts were redesigned in this phase; existing fixed-size and focus-state issues remain for later phases.

## Phase 3: Screens

### Play

- Replaced the fixed three-column composition with a scroll-safe hero/news row and server/Java row. Added the first-launch hint, version selector, Java status, and supplied island/village/laptop assets without changing command or view-model logic.
- Reviewed 960 x 600 and 1200 x 720 captures; the 1600 x 900 capture is constrained by the 1366 x 768 desktop and is documented as incomplete.
- Build and screenshot notes are in `docs/qa.md`.

### Versions

- Added responsive search, Release/Snapshot/Beta+Alpha chips mapped to existing properties, virtualized version rows, and an empty state. The manifest retry/error workflow is not exposed by the current view model and was not fabricated.
- Reviewed 960 x 600 and 1200 x 720 captures; build passed in `VersionsCheck`.

### News and Online

- News now has a 16:9 cover crop with hover scaling, a crystals header, and an empty state. Online uses the actual server model fields, server icons, status, player counts, ping, connect command, and the village header asset. Both preserve existing commands.
- Both screens build and were reviewed at 960 x 600 and 1200 x 720. Their runtime collections were empty during capture, so populated item visuals remain unverified.

### Skins

- Preserved `CanvasImage` and all canvas mouse handlers. Added a compact tool rail, central nearest-neighbor texture canvas, independently scrollable palette/export panel, fox header art, and themed controls.
- Reviewed 960 x 600 and 1200 x 720 captures. Build passed in `SkinsCheck`; mouse drawing and high-DPI behavior remain for manual QA.

### Mods

- Reworked the library and installed JAR panel, added chest/empty-box decoration and a busy progress indication, and retained search/install/add/remove/folder commands.
- Reviewed 960 x 600 and 1200 x 720 captures; build passed in `ModsCheck`. The remote search was still loading during screenshots.
- Enable/disable and drag/drop remain unavailable because no corresponding model properties or handlers exist; implementing them would require the explicitly prohibited logic changes.

### Settings

- Reorganized storage, memory, launch, and about into compact two-column sections with a scrollable narrow layout. Existing path, memory, JVM, visibility, welcome, and save bindings are retained.
- Reviewed 960 x 600 and 1200 x 720 captures; build passed in `SettingsCheck`.
- The 16,384 MiB slider ceiling is above this machine's 12,203 MiB RAM. The saved 9,728 MiB value is about 80% of installed RAM. No hardware-specific XAML maximum or view-model change was made.

### Global shell

- Tokenized the shared window background, typography, sidebar width, footer status, and progress styling. `NavRadio` now has active, hover, pressed, disabled, and focus states; WindowChrome and existing window action handlers are preserved.
- Windows .NET Runtime events identified and verified fixes for `Double` resources passed to `GridLength` and unresolved string commands in the ProgressBar template.
- FinalCheck builds and the updated shell launches. Captured at 1200 x 720; see `docs/qa.md` for the screenshot and remaining viewport/input checks.

## Phase 2: Control library

- Added reusable button variants/sizes, focus visual, themed TextBox/ComboBox/CheckBox/ToggleButton/Slider, virtualized ListBox, scrollbar, ProgressBar, badge, glass card, and skeleton styles in `Themes/Controls/`.
- Removed the default infinite pulse from `ProgressBar.Themed`; indeterminate progress remains a state without a permanent animation clock.
- Build validation passed in the isolated `ControlsCheck` configuration. Four existing DPAPI platform warnings are unrelated to UI styles.

## Workflow constraints

The opened workspace path `C:\ML` is not currently a Git repository (`git status` reports that no repository exists). The user authorized proceeding without per-stage commits; no commit operations will be attempted.
