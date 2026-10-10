---
version: alpha
name: GitGUI — Linear-inspired dark canvas
description: A compact Git desktop interface with neutral surface lifts and restrained lavender controls.
colors:
  canvas: "#010102"
  surface-1: "#0f1011"
  surface-2: "#161719"
  surface-3: "#1c1d20"
  surface-4: "#26282c"
  hairline: "#23252a"
  hairline-strong: "#393b41"
  hairline-tertiary: "#2c2e33"
  primary: "#5e6ad2"
  primary-hover: "#828fff"
  primary-focus: "#5e69d1"
  on-primary: "#ffffff"
  ink: "#f7f8f8"
  ink-muted: "#d0d6e0"
  ink-subtle: "#8a8f98"
  ink-tertiary: "#62666d"
  semantic-overlay: "rgba(0, 0, 0, 0.75)"
typography:
  display-xl:
    fontFamily: Geist
    fontSize: 80px
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: -3px
  display-md:
    fontFamily: Geist
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: -1.5px
  headline:
    fontFamily: Geist
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.6px
  card-title:
    fontFamily: Geist
    fontSize: 22px
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: -0.4px
  body-lg:
    fontFamily: Geist
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: -0.1px
  body:
    fontFamily: Geist
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: -0.05px
  body-sm:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: -0.05px
  caption:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0px
  button:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0px
  eyebrow:
    fontFamily: Geist
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0.4px
  mono:
    fontFamily: Geist Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0px
spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
  section: 96px
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    height: 40px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.canvas}"
  button-primary-pressed:
    backgroundColor: "{colors.primary-focus}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    height: 40px
  button-tertiary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
  button-tertiary-pressed:
    backgroundColor: "{colors.surface-4}"
    textColor: "{colors.ink}"
  history-panel:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.xl}"
  branch-sidebar:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.lg}"
  branch-item-selected:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  history-row-selected:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.ink}"
    height: 28px
  changes-panel:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
  dialog:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  dialog-backdrop:
    backgroundColor: "{colors.semantic-overlay}"
  divider:
    backgroundColor: "{colors.hairline}"
  divider-strong:
    backgroundColor: "{colors.hairline-strong}"
  divider-tertiary:
    backgroundColor: "{colors.hairline-tertiary}"
  text-input:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  text-input-placeholder:
    textColor: "{colors.ink-tertiary}"
  top-nav:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    height: 56px
  footer:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-subtle}"
    typography: "{typography.caption}"
---

## Overview

Apply the supplied Linear marketing direction to GitGUI's existing desktop
workflow. The near-black canvas, four neutral surface lifts, hairline borders,
and restrained lavender keep the commit graph and diffs prominent. Branches,
remote refs, and tags remain visible beside the full-height history graph. The welcome
screen uses a large, tightly tracked headline. The working interface stays dense.

## Colors

Canvas, accent, and text values match the supplied reference. The reference did
not specify hexadecimal values for the four surfaces or stronger hairlines;
those values above are GitGUI approximations, not verified Linear CSS tokens.

Use lavender for the brand mark, primary actions, focus, and links. Use neutral
surfaces for hover and selection. The actual Git graph retains its distinct lane
colors; green additions and red removals retain their functional diff meanings.
Error alerts use neutral surfaces and explicit text with `role="alert"`.

## Typography

Geist and Geist Mono are already bundled locally and serve as the permitted font
substitutes. Use weight 600 for the welcome headline, 500 for controls and dialog
titles, and 400 for body and history text. Scale the welcome headline from 80px
to 40px with proportional negative tracking. General prose uses 16px; the desktop
app uses the compact 14px body variant and 13px commit subjects. Mono belongs to
diffs, object IDs, and ref labels, while navigation and footer use the sans family.

## Layout

Use the 4px spacing rhythm. The app fills its window, with a 56px toolbar, 52px
scope bar, flexible history workspace, and 32px status footer. The repository
workspace has a 224px branch sidebar and a flexible graph column. History uses
the full column height until Working changes is opened. Sidebar and history
scroll independently. Workspace gutters are 16px; dialogs use 24px padding.

Keep the history header at 24px and commit rows at 28px: the graph renderer uses
these exact measurements to align its nodes. Below 1024px, narrow changes-panel
columns and reduce the sidebar to 200px. Below 820px, hide the date column.
Below 768px, place the scrollable branch list above the graph, wrap toolbar actions,
and stack files, diff, and composer. Below 480px, simplify scope-bar spacing. Horizontal
history scrolling preserves commit content on narrow previews. The native app
continues to require an 800px minimum window width.

## Elevation & Depth

Depth comes from surface lifts and 1px hairlines. Add a slightly lighter top border
on lifted panels. Use no drop shadows, atmospheric gradients, or spotlight fills.
Focus uses a 2px lavender outline at 50% opacity. Modals use a black overlay.

## Shapes

Use 8px corners for controls and inputs, 12px for changes panels and dialogs, 16px
for the history frame, and 4–6px for ref chips and file selections. CTAs are never
pill shaped.

## Components

- **button-primary:** Lavender fill, 8px corners, 8px by 14px padding, 40px height.
- **button-primary-hover:** Lighter lavender with dark text to preserve contrast.
- **button-primary-pressed:** Focus lavender with white text.
- **button-secondary:** Surface-1 fill with a hairline border.
- **history-panel:** Surface-1 frame with a neutral surface-3 selected row.
- **branch-sidebar:** Persistent local branches, remote branches, and tags. Use
  neutral selection, a HEAD badge for the checked-out branch, and a Manage action
  for the existing branch dialog. Selecting a ref filters history and preserves
  keyboard focus; All branches restores the complete loaded graph.
- **changes-panel:** Surface-1 file list, diff, and composer with hairline dividers.
- **dialog:** Surface-2, strong hairline, 12px corners, native modal behavior.
- **text-input:** Surface-1, 8px corners, 8px by 12px padding, visible focus outline.
- **top-nav:** Canvas with the GitGUI mark and existing repository actions.
- **footer:** Compact status text on canvas.

Primary actions and inputs grow to at least 44px on coarse-pointer viewports.
Graph rows retain their fixed geometry and existing keyboard navigation.

## Do's and Don'ts

- Keep the canvas at #010102 and lavender scarce.
- Keep the real product interface as the visual focus.
- Preserve keyboard focus, modal labels, alerts, and disabled states.
- Preserve functional graph and diff colors.
- Do not add a light theme, chromatic section fills, gradients, or shadows.
- Do not add marketing pages, pricing cards, or fake repository data to the app.
- Add component states as separate entries when needed.
- Run `npx @google/design.md lint DESIGN.md` after design changes.
