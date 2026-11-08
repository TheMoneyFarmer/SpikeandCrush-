---
slug: loss-limits
title: "Loss limits: the 50% max loss rule and the 2-minute lock"
category: rules
tags: ["max loss", "loss limit", "eliminated", "margin call", "auto close", "50%", "locked", "lockout"]
source: code
needs_review: false
---

# Loss limits: the 50% max loss rule and the 2-minute lock

These apply on top of the margin rules.

**Hard limit (50% max loss).** If your equity falls to 50% below your starting capital ($5,000 or less from $10,000), all your open positions are closed automatically and you are eliminated from trading for the rest of that match. You get a warning when you are down 40%.

**Soft limit (2-minute lock).** If you lose 20% of starting capital within one 2 minutes window, you cannot open new trades until the next window starts. Windows run every 2 minutes from the start of the match.

In long-form competitions, reaching the 50% loss locks the account at its final equity for the rest of the competition. The 2-minute lock applies to matches only.
