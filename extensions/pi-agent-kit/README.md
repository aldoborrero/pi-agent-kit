# pi-agent-kit

Aggregator package for the `@aldoborrero/pi-*` Pi extensions.

Install with:

```bash
pi install npm:@aldoborrero/pi-agent-kit
```

The package imports and activates the bundled extension factories from their npm packages so a single install enables the toolkit.

## External replacements

The bundle directly activates these pinned upstream factories (npm dependencies
are not automatically activated by Pi):

| Capability | Package | Entry |
| --- | --- | --- |
| Structured questions | `@juicesharp/rpiv-ask-user-question@2.12.0` | package export |
| Web search and extraction | `pi-web-access@0.35.0` | `dist/index.js` |
| Notifications | `@bacnh85/pi-notify@0.1.8` | `extensions/index.js` |

They replace, rather than accompany, the local questionnaire/web/notify factories.
Do not also load them as standalone Pi packages. The question tool is now
`ask_user_question`; fetching uses `fetch_content` instead of `web_fetch`.
On Linux install `libnotify` (`notify-send`) for desktop delivery.
