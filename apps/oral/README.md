# ORAL (oral.<DOMAIN>) - devices and agents only

Humans use voice inside their signed-in web app (the Al! button on the board: say
"<brand>.report!" for The Report; owners say "start a mission ..." then "Go Max AI!").

ORAL is for Siri Shortcuts, other agents and devices. Every request needs an agent token with the
`voice` scope (hashed in D1, revocable). No token -> 401.

Mint (signed-in owner/user, or owner token):

    POST https://<DOMAIN>/api/alfred/agent-tokens  {"name":"iPhone Siri","scopes":["voice"]}
    DELETE https://<DOMAIN>/api/alfred/agent-tokens/<id>   # revoke

Siri Shortcut ("Get Contents of URL" -> "Speak Text"):

    POST https://oral.<DOMAIN>/api/voice
    Authorization: Bearer <token>
    Body: text/plain "Alfred report" | application/json {"text": "..."} | audio/* (m4a/wav/mp3)
    Reply: text/plain (default) | audio/mpeg (?format=audio or Accept: audio/mpeg) | JSON (?format=json)

A voice token on the owner tenant can start missions ("Go Max AI! <objective>"). Realtime agents
can also open the `/agents/alfred-oral/<tenant>` socket with the same bearer.
