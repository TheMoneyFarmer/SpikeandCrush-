---
slug: loss-limits
title: "How you can lose: stop-out and the 2-minute lock"
category: rules
tags: ["max loss", "loss limit", "eliminated", "auto close", "locked", "lockout", "blown account", "lose everything", "stopped out", "why was my position closed"]
source: code
needs_review: false
---

# How you can lose: stop-out and the 2-minute lock

Risk is decided by the margin rules (see "Leverage, margin, margin call and stop-out"). There is no fixed maximum loss: small positions can keep running through a bigger drawdown, and big ones get stopped out sooner. You are never removed from a match for losing. If your equity is too low to open anything, you just can't trade until you have free margin.

**Stop-out at 50% margin level.** Your biggest losing position closes automatically, then the next, until the level recovers.

**The 2-minute lock.** If you lose 20% of starting capital within one 2 minutes window, you cannot open new trades until the next window starts. Windows run every 2 minutes from the start of the match. This applies to matches only, not competitions.
