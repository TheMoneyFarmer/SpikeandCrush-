---
slug: match-rules-limits
title: "Starting capital, position limit and lot size"
category: rules
tags: ["starting capital", "lot limit", "max lots", "lot size", "max positions", "how many lots", "rules", "limits"]
source: code
needs_review: false
---

# Starting capital, position limit and lot size

Every match uses the same core rules:

- Starting capital: $10,000 (virtual, resets every match)
- Maximum open positions at once: 10
- Lot size: **there is no lot limit**. How big you can trade depends on your leverage and free margin (see "Leverage and margin").

Two sabotage cards can cap your lot size for a short time: Lot Limiter and Liquidity Drain.

Long-form competitions use the same capital, position limit and margin rules.
