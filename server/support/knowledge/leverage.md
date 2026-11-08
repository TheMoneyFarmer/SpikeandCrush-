---
slug: leverage
title: "Leverage, margin, margin call and stop-out"
category: rules
tags: ["leverage", "margin", "margin call", "stop out", "stop-out", "margin level", "free margin", "how many lots", "lot limit"]
source: code
needs_review: false
---

# Leverage, margin, margin call and stop-out

Every player trades at **100:1 leverage**. There is no lot limit: free margin decides how much you can open.

- **Margin used**: the value of your open positions divided by 100.
- **Free margin**: equity minus margin used. A new trade must fit inside it.
- **Margin level**: equity divided by margin used, as a percentage.

Example: on EUR/USD near 1.08, one lot needs about $1,080 of margin, so $10,000 opens about 9 lots.

**Margin call at 100%.** You get a warning and cannot open new trades until the level recovers.

**Stop-out at 50%.** Your biggest losing position is closed, then the next, until the level recovers. You keep trading with what is left.

The loss limits apply as well (see "Loss limits"). Margin Call is also the name of a sabotage card, which closes a target's open positions.
