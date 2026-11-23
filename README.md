[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/xylo182/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/xylo182/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format, built for make.fun's
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
bounty.

`mend` is a command-line tool that applies the edits AI models write,
in four formats, to a tree of text files: unified diffs (even with wrong
line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor
tool calls. It finds the lines each edit names on the first of three
matching tiers, then writes all changes or none at all, and prints what
changed or why it failed.

Run it with Node 22 and its standard library alone:

    node main.ts [options] [PATCH]

`runner.ts` is the kit's trial runner, kept as shipped.
