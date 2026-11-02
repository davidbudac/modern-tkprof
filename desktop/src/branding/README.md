# TraceLens icon

The approved design is option C: uneven curved brackets around a small rounded square.
The PNG masks preserve that design, with the white background removed and the mark
normalized to solid black. CSS masks let the interface use its theme's ink color.

`BrandIcon` is static by default. `motion="loop"` runs the four-second focus gesture
while loading; `motion="once"` plays it once. Both respect reduced-motion preferences.
The animation moves the brackets inward, then briefly pulses and tilts the center.

`src-tauri/icons/source.png` is the 1024px launcher master: the black mark on a white
rounded tile. Regenerate the platform icons with `pnpm tauri icon src-tauri/icons/source.png`.
`public/favicon.png` is the 64px browser icon. Native launcher icons use the resting pose.

The original selected artwork and editable animation are in
`videos/tracelens-focus/`.
