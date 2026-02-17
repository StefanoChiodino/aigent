# TODO

- [x] Implement /thinking and /reasoning commands — done (deb9242)
- [x] Reasoning text shouldn't be yellow — fixed, all gray now
- [x] Remove "aigent |" prefix from status bar — removed, bar starts with reasoning:

Status bar now shows: `reasoning:medium | in:1.2k out:340 | /help`

If you're still seeing the old UI, the container might need a restart to pick up changes:
`docker compose restart`

- [x] The first time the one presses Ctrl C, if there is already something typed, it should clear up the thing, and it should also make you have to type it twice, instead of just once, just like it would do in Open Claw. I want it to feel like a good CLI like the terminal normally would, you know what I mean?

- [ ] We need to make something a little bit more useful usable when it make files.

