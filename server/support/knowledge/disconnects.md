---
slug: disconnects
title: "Disconnects and leaving a match"
category: rules
tags: ["disconnect", "disconnected", "lost connection", "reconnect", "forfeit", "left match", "match ended"]
source: code
needs_review: true
---

# Disconnects and leaving a match

If you lose connection during a match, you have **60 seconds** to reconnect. Open the same match again and you continue where you were.

If you do not reconnect within 60 seconds, it counts as leaving the match (a forfeit):
- all your open positions are closed,
- you are placed last,
- in ranked modes you get the last-place rating change (-25 in a match of 4 or more players),
- the match carries on for everyone else.

Leaving a match on purpose has the same result.

Note for review: in the code, the "last place" rating change in a 2-player ranked match is +10 and in a 3-player match it is 0, not -25. The Help page FAQ also says disconnected positions stay open, which the code does not do after 60 seconds.
