# Bundled fonts

RepoRunner bundles its UI fonts so the app makes no network requests for them
and works with a strict Content-Security-Policy.

| Family | Weights | License | Upstream project |
|---|---|---|---|
| Plus Jakarta Sans | 400–700 (variable) | SIL Open Font License 1.1 — `PlusJakartaSans-OFL.txt` | https://github.com/tokotype/PlusJakartaSans |
| JetBrains Mono | 400–500 (variable) | SIL Open Font License 1.1 — `JetBrainsMono-OFL.txt` | https://github.com/JetBrains/JetBrainsMono |

Font files are the unmodified WOFF2 subsets served by Google Fonts for
`css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500`
(the request RepoRunner previously made at runtime). License texts are from
https://github.com/google/fonts (`ofl/plusjakartasans/OFL.txt`, `ofl/jetbrainsmono/OFL.txt`).

| File | Bytes | SHA-256 | Source |
|---|---|---|---|
| `jetbrains-mono-cyrillic-ext.woff2` | 1640 | `62213be8a78b42f1e29d1452d91e2f8b3e745572a9dd98d3941e39fa00b37d76` | https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPx3cwhsk.woff2 |
| `jetbrains-mono-cyrillic.woff2` | 8872 | `e17cfd15fb96909d64095015f958207063a0c07191da3512df7d560a781aebdf` | https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxTcwhsk.woff2 |
| `jetbrains-mono-greek.woff2` | 6836 | `0a557721b1f8b36d3f3f84442689a71ca4a744300abcb46a1953f51bfc663b66` | https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxPcwhsk.woff2 |
| `jetbrains-mono-vietnamese.woff2` | 5888 | `c89b9cc0bc6262bd4f8d8494b6961601f3aefa829d08c2e3635f4d501d3a47c2` | https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPx_cwhsk.woff2 |
| `jetbrains-mono-latin-ext.woff2` | 11624 | `db5ff4db83e580426280e9337a58dc57d3a83784a1b03ad80914651594441d52` | https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPx7cwhsk.woff2 |
| `jetbrains-mono-latin.woff2` | 31432 | `83c005d49d8a6a50474c73a5a36ac0468076e9c4a29da7bdb14995d80560a5be` | https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxDcwg.woff2 |
| `plus-jakarta-sans-cyrillic-ext.woff2` | 1716 | `c46a510ab43925a55ecfe6c2d5fad0ce1902cd48ab276621d41f7afa42e4daee` | https://fonts.gstatic.com/s/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko70yyygA.woff2 |
| `plus-jakarta-sans-vietnamese.woff2` | 8352 | `b275d1258601dda240fc6a1d4a6cad56e691d898f5cdf1b0e4fd6ca0022d8e40` | https://fonts.gstatic.com/s/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko50yyygA.woff2 |
| `plus-jakarta-sans-latin-ext.woff2` | 21728 | `38e3b8fd8045048eb311d90170a4429ed2c8f405852dc3d91b5af8452758703f` | https://fonts.gstatic.com/s/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko40yyygA.woff2 |
| `plus-jakarta-sans-latin.woff2` | 27348 | `153fc85b70298beeb1d61a5f723331649e7f23bb77302a66e61cb3e2fbdb5e79` | https://fonts.gstatic.com/s/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko20yw.woff2 |
