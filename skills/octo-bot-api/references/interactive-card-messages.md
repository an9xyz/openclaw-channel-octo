# Card Message Guidance Moved

Card guidance now lives in the progressive `$octo-card-message` skill so an agent loads only the relevant path:

- `../../octo-card-message/references/interactive-submit.md` for `octo_send_card`, submit buttons, forms, and callback turns.
- `../../octo-card-message/references/display-card.md` for `octo_send_display_card` and progress-card presentation.
- `../../octo-card-message/references/raw-api.md` for hand-written type-17 HTTP clients.

Use `$octo-card-message` before card work. This compatibility file intentionally does not duplicate the protocol, schemas, and security rules.
