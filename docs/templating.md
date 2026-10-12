# Templates and formulas

<!-- Generated from the expression helpers, value formats, and widget registry. -->

Use formulas to calculate numeric values. Use text templates to combine text with sensor readings.
Enter these values in the fields marked **(formula)** in the Inspector.

| Input | Use | Example |
| --- | --- | --- |
| Formula | Set a numeric value. Do not include braces. | `clamp(cpu.total, 0, 100)` |
| Text template | Insert readings into text. Put each expression inside braces. | `CPU {round(cpu.total)}%` |

## Template syntax

Put an expression inside `{ }` to insert its result. Text outside the braces stays unchanged.

- Use `{{` and `}}` to display literal braces.
- Braces inside quoted strings do not end the expression.
- A missing reading or invalid expression displays `–` in a text template.
- If a numeric formula fails, the widget uses its ordinary value.

## Expressions

Use the sensor ID as a value, such as `cpu.total`, `mem.used`, or `net.down`.
Open **Sensors** to find the available IDs.

Expressions support JavaScript arithmetic, comparisons, strings, conditional expressions, and `Math` functions.
For example, `cpu.total > 90 ? 'High' : 'Normal'` selects text from the CPU reading.
The helper functions below provide common formatting and calculations.

Expressions cannot access the network, files, or app controls.
Invalid expressions show no calculated value. A missing reading does not become zero.
For execution limits, see the [developer architecture guide](dev/architecture.md#expressions).

## Helper functions

These functions are available in formulas and text templates:

| function | description | example |
| --- | --- | --- |
| `round(x, places = 0)` | Round `x` to `places` decimal places. | `{round(cpu.total, 1)}` |
| `toDecimalPlace(x, places = 0)` | Alias of `round`. | `{toDecimalPlace(mem.used / 3, 1)}` |
| `clamp(x, lo, hi)` | Constrain `x` to the range `[lo, hi]`. | `{clamp(cpu.total, 0, 100)}` |
| `bytes(x, places = 1)` | Bytes as a binary-scaled size, e.g. `16.0 GiB`. | `{bytes(mem.used.bytes)}` |
| `rate(x, places = 1)` | Bytes/second as a size with a `/s` suffix, e.g. `1.0 KiB/s`. | `{rate(net.down)}` |
| `percent(x, places = 0)` | A number with a trailing `%`. | `{percent(cpu.total)}` |

## Named value formats

Use a widget's `format` setting to display one numeric reading.
Choose a format from the table below. An unknown format displays the raw number.
Use a text template when you need labels, calculations, or several readings.

| format | description | example |
| --- | --- | --- |
| `integer` | Rounded to a whole number. | 37 |
| `percent` | A whole-number percentage with a `%` suffix. | 37% |
| `rate` | Bytes/second, binary-scaled, with a `/s` suffix. | 1.0 KiB/s |
| `bytes` | Binary-scaled bytes (B / KiB / MiB / GiB / TiB). | 16.0 GiB |
| `duration` | A whole-seconds duration, two most-significant units. | 3d 4h |

## Fields that accept formulas and templates

The Inspector marks these fields **(formula)**:

| widget | field | accepts | notes |
| --- | --- | --- | --- |
| `gauge` | `value` | formula → number | overrides the sensor, e.g. round(mem.used, 0) or cpu.total / 2 |
| `gauge` | `minExpr` | formula → number | overrides `min` |
| `gauge` | `maxExpr` | formula → number | overrides `max` |
| `bar` | `value` | formula → number | overrides the sensor, e.g. clamp(cpu.total, 0, 100) |
| `bar` | `minExpr` | formula → number | overrides `min` |
| `bar` | `maxExpr` | formula → number | overrides `max` |
| `text` | `value` | template → text | template: text + {expressions}, e.g. CPU {round(cpu.total)}% · {bytes(mem.used.bytes)} |

## Examples

```text
{round(cpu.total)}%                            → 37%
CPU {round(cpu.total)}% · {bytes(mem.used.bytes)}   → CPU 37% · 12.4 GiB
↓ {rate(net.down)}  ↑ {rate(net.up)}           → ↓ 1.2 MiB/s  ↑ 64.0 KiB/s
{round(mem.used)}% of {bytes(mem.total)} used  → 37% of 32.0 GiB used
{cpu.total > 90 ? 'HOT' : 'ok'}                → conditional text
{{literal braces}}                             → {literal braces}
```

Enter numeric formulas without braces:

```text
clamp(cpu.total, 0, 100)
mem.used.bytes / mem.total * 100
```
