# @aldoborrero/pi-common

Shared utilities and helpers for Pi agent extensions.

## Usage

```ts
import { createUiColors } from "@aldoborrero/pi-common";

const colors = createUiColors(theme);
colors.primary("text");
colors.warning("warning");
```

## Exports

| Export | Description |
|---|---|
| `createUiColors(theme)` | Creates a color helper object from a Pi theme |
| `getPressureColor(value, warnPct, errPct)` | Returns a ThemeColor based on a percentage threshold |
| `DEFAULT_WARNING_PERCENT` | Default warning threshold (70) |
| `DEFAULT_ERROR_PERCENT` | Default error threshold (90) |
